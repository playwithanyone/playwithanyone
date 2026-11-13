import { pathToFileURL } from "node:url";
import { createRelease, writeRelease, ReleaseError } from "../../../packages/release/src/release.js";

export async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 8 || args[0] !== "--source" || args[2] !== "--output" || args[4] !== "--game-domain" || args[6] !== "--asset-origin") {
    throw new ReleaseError("CLI_USAGE", "--source <directory> --output <directory> --game-domain <DNS suffix> --asset-origin <HTTPS origin>");
  }
  const prepared = await createRelease(args[1]!, { gameDomain: args[5]!, assetOrigin: args[7]! });
  const written = await writeRelease(prepared, args[3]!);
  // Never print private file contents or server-private schema material.
  console.log(JSON.stringify({
    gameId: prepared.manifest.identity.gameId,
    gameBuildId: prepared.manifest.gameBuildId,
    buildHostLabel: prepared.manifest.buildHostLabel,
    frameOrigin: prepared.manifest.frameOrigin,
    entryUrl: prepared.manifest.entryUrl,
    directory: written.directory,
    reused: written.reused,
    publicArtifacts: prepared.browserManifest.assets.length,
    privateArtifacts: prepared.files.filter(file => file.descriptor.scope === "server-private").length,
    status: "PREPARED_NOT_DEPLOYED",
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ReleaseError) console.error(`${error.code}: ${error.message}`);
    else console.error("RELEASE_IO: publication preparation failed; inspect source/output paths and permissions.");
    process.exitCode = 1;
  });
}
