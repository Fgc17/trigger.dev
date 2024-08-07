import { DEFAULT_RUNTIME, ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { CliApiClient } from "../apiClient.js";
import {
  BundleResult,
  bundleWorker,
  getBundleResultFromBuild,
  logBuildFailure,
  logBuildWarnings,
} from "../build/bundle.js";
import {
  createBuildContext,
  notifyExtensionOnBuildComplete,
  notifyExtensionOnBuildStart,
  resolvePluginsForContext,
} from "../build/extensions.js";
import { createExternalsBuildExtension } from "../build/externals.js";
import { devEntryPoint, telemetryLoader } from "../build/packageModules.js";
import { type DevCommandOptions } from "../commands/dev.js";
import { logger } from "../utilities/logger.js";
import { EphemeralDirectory, getTmpDir } from "../utilities/tempDirectories.js";
import { copyManifestToDir } from "../build/manifests.js";

export type DevSessionOptions = {
  name: string | undefined;
  initialMode: "local";
  showInteractiveDevSession: boolean | undefined;
  rawConfig: ResolvedConfig;
  rawArgs: DevCommandOptions;
  client: CliApiClient;
};

export async function startDevSession({ rawConfig }: DevSessionOptions) {
  const destination = getTmpDir(rawConfig.workingDir, "build");

  logger.debug("Starting dev session", { destination: destination.path, rawConfig });

  const externalsExtension = createExternalsBuildExtension("dev", rawConfig);
  const buildContext = createBuildContext("dev", rawConfig);
  buildContext.prependExtension(externalsExtension);
  await notifyExtensionOnBuildStart(buildContext);
  const pluginsFromExtensions = resolvePluginsForContext(buildContext);

  async function updateBundle(bundle: BundleResult, workerDir?: EphemeralDirectory) {
    try {
      let buildManifest = await createBuildManifestFromBundle(
        bundle,
        destination.path,
        rawConfig,
        workerDir?.path
      );

      buildManifest = await notifyExtensionOnBuildComplete(buildContext, buildManifest);

      logger.debug("Updated bundle", { bundle, buildManifest });
    } catch (error) {
      logger.error("Error updating bundle", { error });
    }
  }

  async function updateBuild(build: esbuild.BuildResult, workerDir: EphemeralDirectory) {
    const bundle = getBundleResultFromBuild(rawConfig.workingDir, build);

    if (bundle) {
      await updateBundle({ ...bundle, stop: undefined }, workerDir);
    }
  }

  let bundled = false;
  const onEnd = {
    name: "on-end",
    setup(b: esbuild.PluginBuild) {
      b.onStart(() => {
        logger.debug("on-end plugin started");
      });
      b.onEnd(async (result: esbuild.BuildResult) => {
        const errors = result.errors;
        const warnings = result.warnings;
        if (errors.length > 0) {
          logBuildFailure(errors, warnings);
          return;
        }

        if (warnings.length > 0) {
          logBuildWarnings(warnings);
        }

        if (!bundled) {
          // First bundle, no need to update bundle
          bundled = true;
        } else {
          const workerDir = getTmpDir(rawConfig.workingDir, "worker");

          await updateBuild(result, workerDir);
        }
      });
    },
  };

  async function runBundle() {
    const bundleResult = await bundleWorker({
      target: "dev",
      cwd: rawConfig.workingDir,
      destination: destination.path,
      watch: true,
      resolvedConfig: rawConfig,
      plugins: [...pluginsFromExtensions, onEnd],
      jsxFactory: rawConfig.build.jsx.factory,
      jsxFragment: rawConfig.build.jsx.fragment,
      jsxAutomatic: rawConfig.build.jsx.automatic,
    });

    await updateBundle(bundleResult);

    return bundleResult.stop;
  }

  const stopBundling = await runBundle();

  return {
    stop: () => {
      logger.debug("Stopping dev session");

      destination.remove();
      stopBundling?.().catch((error) => {});
    },
  };
}

async function createBuildManifestFromBundle(
  bundle: BundleResult,
  destination: string,
  resolvedConfig: ResolvedConfig,
  workerDir: string | undefined
): Promise<BuildManifest> {
  const buildManifest: BuildManifest = {
    runtime: resolvedConfig.runtime ?? DEFAULT_RUNTIME,
    target: "dev",
    files: bundle.files,
    externals: [],
    config: resolvedConfig,
    outputPath: destination,
    workerEntryPath: bundle.workerDevPath ?? devEntryPoint,
    workerForkPath: bundle.workerDevPath ?? devEntryPoint,
    loaderPath: bundle.loaderPath ?? telemetryLoader,
    configPath: bundle.configPath,
    deploy: {
      env: {},
    },
    build: {},
  };

  if (!workerDir) {
    return buildManifest;
  }

  return copyManifestToDir(buildManifest, destination, workerDir);
}
