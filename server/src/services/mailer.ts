import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config } from '../config.js';

/**
 * Mail transport abstraction.
 *  - outbox (dev/test): appends JSON lines to var/mail/outbox.jsonl so flows
 *    (invites, resets, alerts) are fully exercisable and assertable locally.
 *  - smtp (prod): minimal RFC 5321 client with STARTTLS-less plain submission
 *    to an internal relay (TLS termination is expected at the relay; for
 *    direct internet SMTP configure a TLS-fronted relay such as ses-smtp).
 * Failures never throw into request handlers — send() reports success/failure
 * and failures are logged + queued for retry by the notifications job.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

async function sendSmtp(msg: MailMessage): Promise<void> {
  const { smtpHost, smtpPort, smtpUser, smtpPass, from } = config.mail;
  if (!smtpHost) throw new Error('SMTP_HOST not configured');
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: smtpHost, port: smtpPort, timeout: 10_000 });
    let step = 0;
    const fromAddr = from.match(/<(.+)>/)?.[1] ?? from;
    const commands = [
      `EHLO stn.local`,
      ...(smtpUser ? [`AUTH PLAIN ${Buffer.from(`\0${smtpUser}\0${smtpPass}`).toString('base64')}`] : []),
      `MAIL FROM:<${fromAddr}>`,
      `RCPT TO:<${msg.to}>`,
      `DATA`,
      [
        `From: ${from}`,
        `To: ${msg.to}`,
        `Subject: ${msg.subject.replace(/[\r\n]/g, ' ')}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        msg.text.replace(/^\./gm, '..'),
        '.',
      ].join('\r\n'),
      `QUIT`,
    ];
    socket.on('data', (chunk) => {
      const code = Number(String(chunk).slice(0, 3));
      if (code >= 400) {
        socket.destroy();
        reject(new Error(`SMTP error ${code}: ${String(chunk).slice(0, 200)}`));
        return;
      }
      if (step < commands.length) {
        socket.write(`${commands[step]}\r\n`);
        step += 1;
      } else {
        socket.end();
        resolve();
      }
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('SMTP timeout'));
    });
  });
}

async function sendOutbox(msg: MailMessage): Promise<void> {
  fs.mkdirSync(config.mail.outboxDir, { recursive: true });
  const line = `${JSON.stringify({ ...msg, from: config.mail.from, at: new Date().toISOString() })}\n`;
  await fs.promises.appendFile(path.join(config.mail.outboxDir, 'outbox.jsonl'), line);
}

export async function sendMail(msg: MailMessage): Promise<{ ok: boolean; error?: string }> {
  try {
    if (config.mail.transport === 'smtp') await sendSmtp(msg);
    else await sendOutbox(msg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Read the dev outbox (used by tests and the local mail viewer). */
export async function readOutbox(): Promise<Array<MailMessage & { at: string }>> {
  const file = path.join(config.mail.outboxDir, 'outbox.jsonl');
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MailMessage & { at: string });
  } catch {
    return [];
  }
}
