import { ExpoAppManifest, getConfig } from '@expo/config';
import { getRuntimeVersionForSDKVersion } from '@expo/sdk-runtime-versions';
import express from 'express';
import http from 'http';
import { parse } from 'url';
import uuid from 'uuid';

import {
  Analytics,
  Config,
  ProjectAssets,
  ProjectUtils,
  resolveEntryPoint,
  UrlUtils,
} from '../internal';
import { getManifestResponseAsync as getClassicManifestResponseAsync } from './ManifestHandler';

function getPlatformFromRequest(req: express.Request | http.IncomingMessage): string {
  const url = req.url ? parse(req.url, true) : null;
  const platform = url?.query.platform || req.headers['expo-platform'];
  if (!platform) {
    throw new Error('Must specify expo-platform header or query parameter');
  }
  return String(platform);
}

export async function getManifestResponseAsync({
  projectRoot,
  req,
}: {
  projectRoot: string;
  req: express.Request | http.IncomingMessage;
}): Promise<{ body: object; headers: Map<string, any> }> {
  const headers = new Map<string, any>();
  headers.set('expo-protocol-version', 0);
  headers.set('expo-sfv-version', 0);
  headers.set('cache-control', 'private, max-age=0');
  headers.set('content-type', 'application/json');

  const platform = getPlatformFromRequest(req);
  const host = req.headers.host;

  const projectConfig = getConfig(projectRoot);
  const entryPoint = resolveEntryPoint(projectRoot, platform, projectConfig);
  const mainModuleName = UrlUtils.stripJSExtension(entryPoint);

  const classicExpProjectConfig = (
    await getClassicManifestResponseAsync({
      projectRoot,
      platform,
      host,
    })
  ).exp as ExpoAppManifest;
  const runtimeVersion =
    classicExpProjectConfig.runtimeVersion ??
    (classicExpProjectConfig.sdkVersion
      ? getRuntimeVersionForSDKVersion(classicExpProjectConfig.sdkVersion)
      : null);
  const bundleUrl = classicExpProjectConfig.bundleUrl!;

  // Resolve all assets and set them on the manifest as URLs
  const assets = await ProjectAssets.collectManifestAssets(
    projectRoot,
    projectConfig.exp as ExpoAppManifest,
    path => bundleUrl!.match(/^https?:\/\/.*?\//)![0] + 'assets/' + path
  );

  const expoUpdatesManifest = {
    id: uuid.v4(),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset: {
      key: mainModuleName,
      contentType: 'application/javascript',
      url: bundleUrl,
    },
    assets,
    metadata: {}, // required for the client to detect that this is an expo-updates manifest
    extra: {
      expoGoConfig: classicExpProjectConfig,
    },
  };

  return {
    body: expoUpdatesManifest,
    headers,
  };
}

export function getManifestHandler(projectRoot: string) {
  return async (
    req: express.Request | http.IncomingMessage,
    res: express.Response | http.ServerResponse,
    next: (err?: Error) => void
  ) => {
    // Only support `/`, `/manifest`, `/index.exp` for the manifest middleware.
    if (!req.url || parse(req.url).pathname !== '/update-manifest-experimental') {
      next();
      return;
    }

    try {
      const { body, headers } = await getManifestResponseAsync({
        projectRoot,
        req,
      });

      // Send the response
      for (const [headerName, headerValue] of headers) {
        res.setHeader(headerName, headerValue);
      }

      // End the request
      res.end(JSON.stringify(body));

      // Log analytics
      Analytics.logEvent('Serve Expo Updates Manifest', {
        projectRoot,
        developerTool: Config.developerTool,
        runtimeVersion: (body as any).runtimeVersion,
      });
    } catch (e) {
      ProjectUtils.logError(projectRoot, 'expo', e.stack);
      // 5xx = Server Error HTTP code
      res.statusCode = 520;
      res.end(
        JSON.stringify({
          error: e.toString(),
        })
      );
    }
  };
}
