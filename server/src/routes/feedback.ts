import type { FastifyInstance } from 'fastify';
import { errorReportSchema } from '@stn/shared';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { parseOrThrow } from '../lib/validation.js';
import { assertRouteLimit } from '../lib/routeLimit.js';
import { sendMail } from '../services/mailer.js';

/**
 * Anonymous error reports. The client submits a bounded, PII-free diagnostic
 * payload (one tap — no free-typing required); we store it for the admin
 * console and forward it to the operator's inbox when ADMIN_EMAIL is set.
 * The response is honest about what happened so the client can word its
 * confirmation truthfully.
 */
export function registerFeedbackRoutes(app: FastifyInstance): void {
  app.post('/feedback/error-report', async (req) => {
    await assertRouteLimit(`errrep:${req.ip}`, 5, 3600);
    const body = parseOrThrow(errorReportSchema, req.body);

    const row = await query<{ id: string }>(
      `INSERT INTO error_reports (kind, message, detail, app_version, user_agent)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        body.kind,
        body.message,
        JSON.stringify(body.detail),
        body.appVersion ?? null,
        String(req.headers['user-agent'] ?? '').slice(0, 300),
      ],
    );

    let emailed = false;
    if (config.adminEmail) {
      const mail = await sendMail({
        to: config.adminEmail,
        subject: `[Lens of Light] error report: ${body.kind}`,
        text: [
          `Kind: ${body.kind}`,
          `Message: ${body.message}`,
          `App version: ${body.appVersion ?? 'unknown'}`,
          `User agent: ${String(req.headers['user-agent'] ?? 'unknown').slice(0, 300)}`,
          `Report id: ${row.rows[0]!.id}`,
          '',
          'Diagnostics:',
          JSON.stringify(body.detail, null, 2),
        ].join('\n'),
      });
      emailed = mail.ok;
    }

    return { ok: true, stored: true, emailed };
  });
}
