// Run by `npm version <patch|minor|major>`: copies the new package.json version
// into manifest.json and records it in versions.json against minAppVersion.
import { readFileSync, writeFileSync } from "fs";

const version = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
