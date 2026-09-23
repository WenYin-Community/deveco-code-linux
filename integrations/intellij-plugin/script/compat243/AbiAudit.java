/*
 * Copyright (c) 2025 Huawei Device Co., Ltd. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Static bytecode inventory. Does not load plugin classes or launch the IDE.

import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ConstantDynamic;
import org.objectweb.asm.FieldVisitor;
import org.objectweb.asm.Handle;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.jar.JarFile;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Static bytecode inventory tool for ABI compatibility auditing.
 *
 * <p>Scans plugin JARs against the IDE classpath to detect unresolved symbols,
 * duplicate classes, bundled platform runtimes, and other ABI/package problems.
 *
 * @since 2025-09-23
 * @version 1.0
 */
public class AbiAudit {

    static final Map<String, Location> index = new HashMap<>();
    static final Map<String, Definition> definitions = new HashMap<>();
    static final Set<String> absent = new HashSet<>();
    static final Map<String, Set<String>> issues = new TreeMap<>();
    static final List<Location> pluginClasses = new ArrayList<>();
    static final Set<String> pluginNames = new HashSet<>();
    static final List<ZipFile> openJarFiles = new ArrayList<>();

    static int scanned;

    record Location(ZipFile zip, ZipEntry entry, String jar) {}

    record Definition(String parent, List<String> interfaces, Set<String> methods,
            Set<String> fields) {}

    /**
     * Indexes all class entries in a JAR file.
     *
     * @param path path to the JAR file
     * @param plugin whether the JAR is a plugin JAR
     * @throws Exception if the JAR file cannot be read
     */
    static void indexJar(Path path, boolean plugin) throws Exception {
        JarFile zip = new JarFile(path.toFile(), false, ZipFile.OPEN_READ,
                Runtime.Version.parse("21"));
        openJarFiles.add(zip);
        for (ZipEntry entry : zip.versionedStream().toList()) {
            String name = entry.getName();
            if (!name.endsWith(".class") || name.startsWith("META-INF/")
                    || name.equals("module-info.class")) {
                continue;
            }
            name = name.substring(0, name.length() - 6);
            Location loc = new Location(zip, entry, path.toString());
            if (plugin) {
                pluginClasses.add(loc);
                if (!pluginNames.add(name)) {
                    issue("DUPLICATE_PLUGIN_CLASS " + name, path.toString());
                }
                if (name.startsWith("kotlin/")
                        || name.startsWith("kotlinx/coroutines/")) {
                    issue("BUNDLED_PLATFORM_RUNTIME " + name, path.toString());
                }
            }
            // Match the IDE-first policy for Kotlin/coroutines;
            // plugin classes otherwise take precedence.
            if (!plugin || name.startsWith("kotlin/")
                    || name.startsWith("kotlinx/coroutines/")) {
                index.putIfAbsent(name, loc);
            } else {
                index.put(name, loc);
            }
        }
    }

    /**
     * Loads and caches a class definition (superclass, interfaces, members).
     *
     * @param name internal class name (e.g. {@code java/lang/String})
     * @return the definition, or {@code null} if the class cannot be found
     */
    static Definition definition(String name) {
        if (name.startsWith("[")) {
            return definition("java/lang/Object");
        }
        if (definitions.containsKey(name)) {
            return definitions.get(name);
        }
        if (absent.contains(name)) {
            return null;
        }
        try {
            return readDefinition(name);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Parses and caches the definition of one indexed class.
     *
     * @param name internal class name (e.g. {@code java/lang/String})
     * @return the definition, or {@code null} if the class cannot be found
     * @throws IOException if the class bytes cannot be read
     */
    static Definition readDefinition(String name) throws IOException {
        Location loc = index.get(name);
        try (InputStream stream = loc == null
                ? ClassLoader.getPlatformClassLoader().getResourceAsStream(
                        name + ".class")
                : loc.zip.getInputStream(loc.entry)) {
            if (stream == null) {
                absent.add(name);
                return null;
            }
            ClassReader reader = new ClassReader(stream);
            Set<String> methods = new HashSet<>();
            Set<String> fields = new HashSet<>();
            reader.accept(new ClassVisitor(Opcodes.ASM9) {
                /** {@inheritDoc} */
                @Override
                public MethodVisitor visitMethod(int a, String n, String d,
                        String s, String[] e) {
                    methods.add(n + d);
                    return null;
                }

                /** {@inheritDoc} */
                @Override
                public FieldVisitor visitField(int a, String n, String d,
                        String s, Object v) {
                    fields.add(n + d);
                    return null;
                }
            }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG
                    | ClassReader.SKIP_FRAMES);
            Definition def = new Definition(reader.getSuperName(),
                    Arrays.asList(reader.getInterfaces()), methods, fields);
            definitions.put(name, def);
            return def;
        }
    }

    /**
     * Checks whether a member exists in a class hierarchy.
     *
     * @param owner internal class name
     * @param key member key (name + descriptor)
     * @param method whether the member is a method
     * @param visited set of already-visited classes (recursion guard)
     * @return {@code true} if the member is found
     */
    static boolean member(String owner, String key, boolean method,
            Set<String> visited) {
        if (!visited.add(owner)) {
            return false;
        }
        Definition def = definition(owner);
        if (def == null) {
            return false;
        }
        if ((method ? def.methods : def.fields).contains(key)) {
            return true;
        }
        if (key.startsWith("<init>")) {
            return false;
        }
        if (owner.startsWith("[") && key.startsWith("clone(")) {
            return true;
        }
        if (owner.equals("java/lang/invoke/MethodHandle")
                && (key.startsWith("invoke(") || key.startsWith("invokeExact("))) {
            return true;
        }
        if (owner.equals("java/lang/invoke/VarHandle")) {
            return true;
        }
        if (def.parent != null && member(def.parent, key, method, visited)) {
            return true;
        }
        for (String parent : def.interfaces) {
            if (member(parent, key, method, visited)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Records an issue found during scanning.
     *
     * @param key issue key
     * @param source source location
     */
    static void issue(String key, String source) {
        issues.computeIfAbsent(key, k -> new TreeSet<>()).add(source);
    }

    /**
     * Checks whether a type is resolvable and records an issue if not.
     *
     * @param name internal type name or descriptor
     * @param source source location for issue reporting
     */
    static void type(String name, String source) {
        if (name.startsWith("[")) {
            descriptor(name, source);
            return;
        }
        if (definition(name) == null) {
            issue("CLASS " + name, source);
        }
    }

    /**
     * Resolves all types referenced in an ASM type.
     *
     * @param t the ASM type to inspect
     * @param source source location for issue reporting
     */
    static void asmType(Type t, String source) {
        if (t.getSort() == Type.OBJECT) {
            type(t.getInternalName(), source);
        } else if (t.getSort() == Type.ARRAY) {
            asmType(t.getElementType(), source);
        } else if (t.getSort() == Type.METHOD) {
            asmType(t.getReturnType(), source);
            for (Type a : t.getArgumentTypes()) {
                asmType(a, source);
            }
        }
    }

    /**
     * Parses a type descriptor and checks all referenced types.
     *
     * @param desc JVM type descriptor string
     * @param source source location for issue reporting
     */
    static void descriptor(String desc, String source) {
        asmType(Type.getType(desc), source);
    }

    /**
     * Checks whether a field or method reference is resolvable.
     *
     * @param owner owner class internal name
     * @param name member name
     * @param desc member descriptor
     * @param method whether the reference is a method
     * @param source source location for issue reporting
     */
    static void reference(String owner, String name, String desc,
            boolean method, String source) {
        type(owner, source);
        descriptor(desc, source);
        if (definition(owner) != null
                && !member(owner, name + desc, method, new HashSet<>())) {
            issue((method ? "METHOD " : "FIELD ") + owner + "." + name + desc,
                    source);
        }
    }

    /**
     * Inspects a constant pool entry for type references.
     *
     * @param c the constant value
     * @param source source location for issue reporting
     */
    static void constant(Object c, String source) {
        if (c instanceof Type t) {
            asmType(t, source);
        }
        if (c instanceof Handle h) {
            reference(h.getOwner(), h.getName(), h.getDesc(), h.getTag() > 4,
                    source);
        }
        if (c instanceof ConstantDynamic d) {
            descriptor(d.getDescriptor(), source);
            constant(d.getBootstrapMethod(), source);
            for (int i = 0; i < d.getBootstrapMethodArgumentCount(); i++) {
                constant(d.getBootstrapMethodArgument(i), source);
            }
        }
    }

    /**
     * Creates an annotation visitor that checks Kotlin DebugMetadata version.
     *
     * @param source source location for issue reporting
     * @return the annotation visitor
     */
    static AnnotationVisitor debugMetadataVisitor(String source) {
        return new AnnotationVisitor(Opcodes.ASM9) {
            /** {@inheritDoc} */
            @Override
            public void visit(String n, Object v) {
                if (n.equals("v") && v instanceof Integer i && i > 1) {
                    issue("DEBUG_METADATA_V2", source);
                }
            }
        };
    }

    /**
     * Scans a single plugin class for unresolved references.
     *
     * @param loc the class location to scan
     * @throws Exception if the class bytes cannot be read
     */
    static void scan(Location loc) throws Exception {
        ClassReader reader;
        try (InputStream in = loc.zip.getInputStream(loc.entry)) {
            reader = new ClassReader(in);
        }
        String source = Path.of(loc.jar).getFileName() + ":"
                + reader.getClassName();
        if (reader.readUnsignedShort(6) > 65) {
            issue("BYTECODE_ABOVE_JAVA21", source);
        }
        reader.accept(new ClassVisitor(Opcodes.ASM9) {
            /** {@inheritDoc} */
            @Override
            public void visit(int v, int a, String n, String s, String p,
                    String[] is) {
                if (p != null) {
                    type(p, source);
                }
                for (String i : is) {
                    type(i, source);
                }
            }

            /** {@inheritDoc} */
            @Override
            public AnnotationVisitor visitAnnotation(String d,
                    boolean visible) {
                if (d.equals(
                        "Lkotlin/coroutines/jvm/internal/DebugMetadata;")) {
                    return debugMetadataVisitor(source);
                }
                return null;
            }

            /** {@inheritDoc} */
            @Override
            public FieldVisitor visitField(int a, String n, String d, String s,
                    Object v) {
                descriptor(d, source);
                return null;
            }

            /** {@inheritDoc} */
            @Override
            public MethodVisitor visitMethod(int a, String n, String d, String s,
                    String[] e) {
                String at = source + "#" + n;
                descriptor(d, at);
                visitExceptions(e, at);
                return methodVisitor(at);
            }
        }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        scanned++;
    }

    /**
     * Checks all exception types declared by a method.
     *
     * @param exceptions exception internal names, may be {@code null}
     * @param at location of the owning method for issue reporting
     */
    static void visitExceptions(String[] exceptions, String at) {
        if (exceptions != null) {
            for (String x : exceptions) {
                type(x, at);
            }
        }
    }

    /**
     * Creates a method visitor that checks every instruction reference.
     *
     * @param at location of the owning method for issue reporting
     * @return the method visitor
     */
    static MethodVisitor methodVisitor(String at) {
        return new MethodVisitor(Opcodes.ASM9) {
            /** {@inheritDoc} */
            @Override
            public void visitTypeInsn(int o, String t) {
                type(t, at);
            }

            /** {@inheritDoc} */
            @Override
            public void visitFieldInsn(int o, String owner, String name,
                    String desc) {
                reference(owner, name, desc, false, at);
            }

            /** {@inheritDoc} */
            @Override
            public void visitMethodInsn(int o, String owner, String name,
                    String desc, boolean itf) {
                reference(owner, name, desc, true, at);
            }

            /** {@inheritDoc} */
            @Override
            public void visitLdcInsn(Object c) {
                constant(c, at);
            }

            /** {@inheritDoc} */
            @Override
            public void visitInvokeDynamicInsn(String n, String d, Handle b,
                    Object... args) {
                descriptor(d, at);
                constant(b, at);
                for (Object arg : args) {
                    constant(arg, at);
                }
            }

            /** {@inheritDoc} */
            @Override
            public void visitMultiANewArrayInsn(String d, int dimensions) {
                descriptor(d, at);
            }

            /** {@inheritDoc} */
            @Override
            public void visitTryCatchBlock(Label s, Label e, Label h,
                    String t) {
                if (t != null) {
                    type(t, at);
                }
            }
        };
    }

    /**
     * Unpacks a plugin ZIP into a temporary directory.
     *
     * @param pluginPath path to the plugin ZIP or extracted lib directory
     * @param originalPath original plugin path string for issue reporting
     * @param reportDir report path (parent used for temp directory)
     * @return the unpacked lib directory, or the original path if already a dir
     * @throws Exception if the ZIP cannot be read or files cannot be copied
     */
    static Path unpackPlugin(Path pluginPath, String originalPath,
            Path reportDir) throws Exception {
        if (!Files.isRegularFile(pluginPath)) {
            return pluginPath;
        }
        Path unpacked = reportDir.toAbsolutePath().getParent()
                .resolve("abi-audit-libs");
        Files.createDirectories(unpacked);
        try (var oldFiles = Files.list(unpacked)) {
            for (Path old : oldFiles.toList()) {
                Files.delete(old);
            }
        }
        try (ZipFile archive = new ZipFile(pluginPath.toFile())) {
            unpackJarLibs(unpacked, archive);
        }
        if (!Files.exists(unpacked.resolve("acp-jvm-0.25.0-deveco243.jar"))) {
            issue("MISSING_ADAPTED_ACP", originalPath);
        }
        if (Files.exists(unpacked.resolve("acp-jvm-0.25.0.jar"))) {
            issue("UNADAPTED_ACP_PACKAGED", originalPath);
        }
        return unpacked;
    }

    /**
     * Copies plugin lib JARs from a ZIP archive into the unpacked directory.
     *
     * @param unpacked directory to write the JAR files into
     * @param archive the plugin ZIP archive
     * @throws IOException if a JAR file cannot be copied
     */
    static void unpackJarLibs(Path unpacked, ZipFile archive) throws IOException {
        for (ZipEntry entry : Collections.list(archive.entries())) {
            if (entry.getName().matches("[^/]+/lib/[^/]+\\.jar")) {
                Path jar = unpacked.resolve(
                        Path.of(entry.getName()).getFileName());
                try (InputStream in = archive.getInputStream(entry)) {
                    Files.copy(in, jar);
                }
            }
        }
    }

    /**
     * Walks a directory tree and indexes all JAR files.
     *
     * @param root the root directory to walk
     * @param plugin whether the JARs are plugin JARs
     * @throws Exception if a directory walk or JAR read fails
     */
    static void indexAllJars(Path root, boolean plugin) throws Exception {
        try (var paths = Files.walk(root)) {
            for (Path p : paths.filter(p -> p.toString().endsWith(".jar"))
                    .sorted().toList()) {
                indexJar(p, plugin);
            }
        }
    }

    /**
     * Filters out optional native-image build-only symbols.
     *
     * <p>Only SQLite's GraalVM build-time hook: never loaded by this JBR plugin.
     * Keep the exact callers visible in the report, not a global GraalVM
     * exclusion.
     *
     * @return set of issue keys that are optional build-only symbols
     */
    static Set<String> filterOptionalNativeImage() {
        Set<String> optional = new HashSet<>();
        for (var entry : issues.entrySet()) {
            if (entry.getKey().startsWith(
                    "CLASS org/graalvm/nativeimage/hosted/")
                    && entry.getValue().stream().allMatch(c -> c.startsWith(
                            "sqlite-jdbc-3.51.1.0.jar:"
                                    + "org/sqlite/nativeimage/SqliteJdbcFeature"))) {
                optional.add(entry.getKey());
            }
        }
        return optional;
    }

    /**
     * Writes the audit report to the specified path.
     *
     * @param reportPath output file path
     * @param required count of required unresolved findings
     * @param optionalNativeImage set of optional build-only symbols
     * @throws Exception if the report file cannot be written
     */
    static void writeReport(String reportPath, int required,
            Set<String> optionalNativeImage) throws Exception {
        try (PrintWriter out = new PrintWriter(reportPath)) {
            out.println("Scanned plugin classes: " + scanned
                    + "; indexed IDE/plugin classes: " + index.size());
            out.println("Required unresolved symbols/package problems: "
                    + required
                    + "; optional native-image build-only symbols: "
                    + optionalNativeImage.size());
            out.println("Scope: Java 21 effective classes; direct references "
                    + "and inherited member lookup, debug metadata, "
                    + "duplicate/runtime packaging. "
                    + "No plugin classes are loaded or executed.");
            out.println("Limits: reflection, dynamic classloader topology, "
                    + "member access flags, native execution and backend/model "
                    + "behavior require separate review or user acceptance.");
            for (var entry : issues.entrySet()) {
                out.println((optionalNativeImage.contains(entry.getKey())
                        ? "OPTIONAL_BUILD_ONLY " : "ERROR ")
                        + entry.getKey());
                for (String caller : entry.getValue()) {
                    out.println("  " + caller);
                }
            }
        }
    }

    /**
     * Entry point for the static bytecode inventory tool.
     *
     * <p>Usage: {@code java AbiAudit <IDE Contents/lib> <plugin ZIP>
     * <report path>}
     *
     * @param args IDE Contents/lib path, plugin ZIP path, report output path
     * @throws Exception if indexing, scanning, or report writing fails
     */
    public static void main(String[] args) throws Exception {
        // args: IDE Contents/lib, final plugin ZIP (or extracted lib), report path
        Path pluginPath = unpackPlugin(Path.of(args[1]), args[1],
                Path.of(args[2]));
        indexAllJars(Path.of(args[0]), false);
        indexAllJars(pluginPath, true);
        for (Location l : pluginClasses) {
            scan(l);
        }
        for (ZipFile zip : openJarFiles) {
            zip.close();
        }
        Set<String> optionalNativeImage = filterOptionalNativeImage();
        int required = issues.size() - optionalNativeImage.size();
        writeReport(args[2], required, optionalNativeImage);
        System.out.println("Static inventory written: " + args[2]
                + " (" + scanned + " classes, " + required
                + " required findings, " + optionalNativeImage.size()
                + " optional build-only findings)");
        if (required != 0) {
            throw new IllegalStateException(
                    "Unresolved 243 ABI/package findings; see " + args[2]);
        }
    }
}
