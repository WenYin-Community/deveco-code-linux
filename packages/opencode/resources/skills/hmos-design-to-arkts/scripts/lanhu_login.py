#!/usr/bin/env python3
"""Log in to Lanhu locally and save a verified session for dsphper's MCP."""

import argparse
import asyncio
import io
import json
import locale
import os
from pathlib import Path
import stat
import signal
import subprocess
import sys
import tempfile
import time


CHECK_URL = "https://lanhuapp.com/api/account/user_teams"
LOGIN_URL = "https://lanhuapp.com/"


class LoginError(Exception):
    pass


def check_path(path):
    for item in (path, *path.parents):
        if item.is_symlink():
            raise LoginError("unsafe_path")


def protect_private(path):
    check_path(path)
    if os.name != "nt":
        path.chmod(0o700 if path.is_dir() else 0o600)
        return
    # icacls rewrites only the DACL, which an unprivileged owner may always
    # write. Set-Acl round-trips the whole descriptor and fails with a
    # missing SeSecurityPrivilege on descriptors produced by icacls.
    sid = current_user_sid()
    # Keep "/grant:r" and the ACE spec as separate arguments: icacls on
    # Windows 11 24H2+ rejects the combined "/grant:r:Sid:perm" form with
    # error 87; the documented syntax is space-separated.
    result = subprocess.run(
        ["icacls.exe", str(path), "/inheritance:r", "/grant:r",
         f"*{sid}:{'(OI)(CI)F' if path.is_dir() else 'F'}"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).decode(locale.getpreferredencoding(False), "replace").strip()
        raise LoginError("credential_acl_failed: " + detail if detail else "credential_acl_failed")


def current_user_sid():
    result = subprocess.run(["whoami.exe", "/user", "/fo", "csv", "/nh"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    # The CSV row is "DOMAIN\user","S-1-..."; the SID is the last column.
    rows = result.stdout.decode(locale.getpreferredencoding(False), "replace").strip().splitlines()
    sid = rows[-1].split(",")[-1].strip().strip('"') if rows else ""
    if result.returncode != 0 or not sid.startswith("S-1-"):
        raise LoginError("credential_acl_failed: unable to resolve the current user SID")
    return sid


def cookie_header(cookies):
    # Playwright applies domain/path/expiry rules before returning these cookies.
    parts = [f"{item['name']}={item['value']}" for item in cookies]
    cookie = "; ".join(parts)
    if not cookie or any(ord(char) < 32 or ord(char) > 126 for char in cookie) or "${" in cookie:
        raise LoginError("invalid_cookie")
    return cookie


async def check_session(cookie, endpoint=CHECK_URL):
    import httpx

    if not cookie or any(ord(char) < 32 or ord(char) > 126 for char in cookie):
        return "login_required"
    # Match dsphper's Cookie-only authentication. A browser request might succeed
    # using a localStorage Authorization header that the MCP cannot reproduce.
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        try:
            response = await client.get(endpoint, headers={
                "Cookie": cookie,
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://lanhuapp.com/web/",
                "Accept": "application/json, text/plain, */*",
                "request-from": "web",
                "real-path": "/item/project/product",
            })
        except httpx.HTTPError:
            return "network_error"
    try:
        result = response.json()
    except ValueError:
        return "unexpected_response"
    if not isinstance(result, dict):
        return "unexpected_response"
    if response.status_code == 200 and str(result.get("code")) in ("0", "00000"):
        return "authenticated"
    if response.status_code in (401, 403) or str(result.get("code")) in ("5", "30001"):
        return "login_required"
    return "unexpected_response"


def save_cookie(path, cookie):
    from dotenv import dotenv_values
    from dotenv.parser import parse_stream

    check_path(path)
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        raise LoginError("unsafe_path")
    # Restrict the old file too, without ever writing an unverified credential.
    if path.exists():
        protect_private(path)
    if any(char in cookie for char in ("\r", "\n", "\0")) or "${" in cookie:
        raise LoginError("invalid_cookie")
    value = cookie.replace("\\", "\\\\").replace('"', '\\"')
    line = f'LANHU_COOKIE="{value}"\n'
    original = path.read_text() if path.exists() else ""
    output = []
    for entry in parse_stream(io.StringIO(original)):
        if entry.error:
            raise LoginError("invalid_env_file")
        if entry.key == "LANHU_COOKIE":
            continue
        output.append(entry.original.string)
    text = "".join(output)
    updated = text + ("\n" if text and not text.endswith("\n") else "") + line
    if dotenv_values(stream=io.StringIO(updated)).get("LANHU_COOKIE") != cookie:
        raise LoginError("invalid_cookie")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=".lanhu_login-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as target:
            protect_private(Path(name))
            target.write(updated)
            target.flush()
            os.fsync(target.fileno())
        check_path(path)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def emit(status, **fields):
    # Never include HTTP payloads, browser exceptions, cookie names or values.
    print(json.dumps({"status": status, **fields}, ensure_ascii=False), flush=True)


async def browser_login(playwright, profile, headless, timeout):
    from playwright.async_api import Error

    check_path(profile)
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    protect_private(profile)
    context = await playwright.chromium.launch_persistent_context(
        str(profile), headless=headless, viewport={"width": 1280, "height": 900},
    )
    try:
        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
        except Error:
            # Analytics/navigation can time out after the login page is usable.
            pass
        deadline = time.monotonic() + timeout
        while True:
            if not context.pages:
                return "browser_closed", None
            cookies = await context.cookies(CHECK_URL)
            cookie = cookie_header(cookies) if cookies else ""
            status = await check_session(cookie)
            if status == "authenticated":
                return status, cookie
            if headless or time.monotonic() >= deadline:
                return status if headless else "login_timeout", None
            await asyncio.sleep(2)
    finally:
        await context.close()


async def login(args):
    from dotenv import dotenv_values

    check_path(args.env_file)
    if args.env_file.exists():
        if not stat.S_ISREG(args.env_file.stat().st_mode):
            raise LoginError("unsafe_path")
        protect_private(args.env_file)
    current = dotenv_values(args.env_file).get("LANHU_COOKIE") if args.env_file.exists() else ""
    status = await check_session(current)
    if status == "authenticated":
        emit(status, credentialFile=str(args.env_file), source="existing_credential")
        return 0
    if args.check:
        emit(status)
        return 1

    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        status, cookie = await browser_login(playwright, args.profile_dir, True, 0)
        if status != "authenticated" and not args.headless_only:
            emit("waiting_for_login", message="请在新打开的蓝湖窗口中登录，完成后会自动保存。")
            status, cookie = await browser_login(playwright, args.profile_dir, False, args.timeout)
    if status != "authenticated":
        emit(status, credentialsUpdated=False)
        return 1
    save_cookie(args.env_file, cookie)
    emit("authenticated", credentialFile=str(args.env_file), source="browser_session", reconnectMcp=True)
    return 0


def cancel(signum, frame):
    raise KeyboardInterrupt


def main():
    signal.signal(signal.SIGTERM, cancel)
    base = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")) if os.name == "nt" else os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    root = Path(base) / "deveco" / "lanhu"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=root / "credentials.env")
    parser.add_argument("--profile-dir", type=Path, default=root / "browser-profile")
    parser.add_argument("--timeout", type=int, choices=range(1, 1801), metavar="1..1800", default=600)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true", help="Check the saved credential without opening a browser")
    modes.add_argument("--headless-only", action="store_true", help="Reuse the dedicated browser session without a login window")
    args = parser.parse_args()
    args.env_file = args.env_file.expanduser().absolute()
    args.profile_dir = args.profile_dir.expanduser().absolute()
    try:
        return asyncio.run(login(args))
    except LoginError as error:
        emit(str(error), credentialsUpdated=False)
    except ImportError:
        emit("dependency_unavailable", message="请使用已安装完整蓝湖 MCP 和 Playwright 的 Python 环境。")
    except KeyboardInterrupt:
        emit("cancelled", credentialsUpdated=False)
    except Exception:
        emit("login_failed", message="请检查网络、Chromium 安装及登录窗口是否被关闭；已有凭据保持不变。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
