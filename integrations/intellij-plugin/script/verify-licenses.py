# SPDX-License-Identifier: Apache-2.0

import argparse
import re
import shutil
from pathlib import Path
from tempfile import TemporaryFile
from zipfile import ZipFile


def verify(directory: Path, repository: Path, expected_count: int) -> None:
    archives = sorted(directory.glob("*.zip"))
    if len(archives) != expected_count:
        raise ValueError(f"Expected {expected_count} plugin ZIPs, found {len(archives)}")
    expected = {
        f"META-INF/deveco/{name}": (repository / name).read_bytes()
        for name in (
            "LICENSE",
            "LICENSING.md",
            "NOTICE",
            "LICENSES/MIT.txt",
        )
    }
    for archive in archives:
        with ZipFile(archive) as package:
            plugin_jars = [
                name
                for name in package.namelist()
                if re.search(r"(^|/)lib/deveco-code-jetbrains-plugin-[^/]+\.jar$", name)
            ]
            if len(plugin_jars) != 1:
                raise ValueError(f"{archive.name}: expected exactly one plugin implementation JAR, found {len(plugin_jars)}")
            # The implementation JAR embeds the CLI, so copy it to disk instead of memory.
            with package.open(plugin_jars[0]) as source, TemporaryFile() as temporary:
                shutil.copyfileobj(source, temporary)
                temporary.seek(0)
                with ZipFile(temporary) as jar:
                    missing = sorted(set(expected) - set(jar.namelist()))
                    if missing:
                        raise ValueError(f"{archive.name}: missing license files: {', '.join(missing)}")
                    for filename, contents in expected.items():
                        if jar.read(filename) != contents:
                            raise ValueError(f"{archive.name}: license content mismatch: {filename}")
        print(f"Verified licensing files in {archive.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verify licensing files inside built IntelliJ plugin ZIPs")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--expected-count", type=int, required=True)
    args = parser.parse_args()
    verify(args.directory, args.repository, args.expected_count)
