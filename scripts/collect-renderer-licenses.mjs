import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDirectory);
const targetRoot = path.join(projectRoot, "release", "third-party-licenses", "renderer");
const packageLock = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"),
);
const packages = new Map();

for (const [relativePath, metadata] of Object.entries(packageLock.packages ?? {})) {
  if (
    !relativePath.startsWith("node_modules/") ||
    metadata.dev === true ||
    metadata.devOptional === true
  ) {
    continue;
  }

  const packageDirectory = path.join(projectRoot, ...relativePath.split("/"));
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const key = `${packageMetadata.name}@${packageMetadata.version}`;
  if (!packages.has(key)) {
    packages.set(key, {
      directory: packageDirectory,
      name: packageMetadata.name,
      version: packageMetadata.version,
      license: packageMetadata.license ?? metadata.license ?? "Unknown",
    });
  }
}

fs.mkdirSync(targetRoot, { recursive: true });
const inventory = [];
for (const [key, packageInfo] of [...packages.entries()].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  const licenseFiles = fs
    .readdirSync(packageInfo.directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(entry.name),
    );
  if (licenseFiles.length === 0) {
    throw new Error(`No license file found for ${key}.`);
  }

  const safeName = key.replace(/[^A-Za-z0-9._-]/g, "_");
  const destination = path.join(targetRoot, safeName);
  fs.mkdirSync(destination, { recursive: true });
  for (const licenseFile of licenseFiles) {
    fs.copyFileSync(
      path.join(packageInfo.directory, licenseFile.name),
      path.join(destination, licenseFile.name),
    );
  }
  inventory.push({
    name: packageInfo.name,
    version: packageInfo.version,
    license: packageInfo.license,
  });
}

process.stdout.write(JSON.stringify(inventory));
