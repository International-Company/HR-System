import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule, type AppDeps } from './app.module.js';
import { requestContext } from './common/request-context.js';

export const API_PREFIX = 'api/v1';

export async function createApp(
  deps: AppDeps,
  opts: { logger?: boolean } = {},
): Promise<INestApplication> {
  const logger =
    opts.logger === false
      ? false
      : new ConsoleLogger({ json: deps.config.logJson, colors: !deps.config.logJson });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    logger,
    bodyParser: false,
  });
  const cfg = deps.config;

  app.disable('x-powered-by');
  app.set('trust proxy', cfg.TRUST_PROXY > 0 ? cfg.TRUST_PROXY : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Mantine injects CSS variables via <style>; scripts remain strictly 'self'.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(cfg.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: cfg.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'same-origin' },
      frameguard: { action: 'deny' },
    }),
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    next();
  });
  app.use(cookieParser());
  app.use(`/${API_PREFIX}`, express.json({ limit: '100kb' }));

  // Request context + access log (no query strings, no bodies, no secrets).
  const access = new Logger('Access');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    const ctx = {
      requestId: (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID(),
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };
    res.setHeader('X-Request-Id', ctx.requestId);
    if (req.path.startsWith(`/${API_PREFIX}`)) res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () => {
      if (req.path.endsWith('/health/live')) return;
      const c = requestContext.get() ?? ctx;
      access.log(
        `${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms rid=${ctx.requestId} uid=${(c as { actorUserId?: string }).actorUserId ?? '-'}`,
      );
    });
    requestContext.run(ctx, () => next());
  });

  app.setGlobalPrefix(API_PREFIX);

  // Serve the built PWA from the same origin (cookies stay first-party, no CORS).
  const webDist = resolve(cfg.WEB_DIST_DIR ?? join(process.cwd(), '..', 'web', 'dist'));
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, path) => {
          if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith(`/${API_PREFIX}`)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  await app.init();
  return app;
}
