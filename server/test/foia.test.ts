import { describe, it, expect, beforeAll } from 'vitest';
import { getApp, createUser, auth, makeJurisdiction, type TestUser } from './helpers.js';
import { query } from '../src/db/pool.js';

let user: TestUser;
let oaklandId: string;

beforeAll(async () => {
  user = await createUser('editor');
  oaklandId = await makeJurisdiction('Oakland FOIA City', 'city', 'California');
  await query(
    `INSERT INTO foia_templates (name, technology, body) VALUES
     ('Test LPR template', 'lpr', 'To {{JURISDICTION}}: Under {{LAW_NAME}} {{CITATION}} since {{SINCE_DATE}}. {{DEADLINE_SENTENCE}} — {{REQUESTER_NAME}} ({{EMAIL}})')
     ON CONFLICT (name) DO NOTHING`,
  );
});

describe('FOIA workflows', () => {
  it('compose builds a statute-correct letter (California CPRA, 10 calendar days)', async () => {
    const app = await getApp();
    const templates = await app.inject({ url: '/api/v1/foia/templates' });
    const template = templates.json().items.find((t: { name: string }) => t.name === 'Test LPR template');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/foia/compose',
      headers: auth(user),
      payload: { templateId: template.id, jurisdictionId: oaklandId, requesterName: 'Jane Reporter' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.body).toContain('California Public Records Act');
    expect(body.body).toContain('7920');
    expect(body.body).toContain('Jane Reporter');
    expect(body.body).toContain('within 10 calendar days');
    expect(body.statute.abbr).toBe('CA');
    expect(body.suggestedDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('full lifecycle: draft → sent (auto due date) → acknowledged → response, invalid transitions rejected', async () => {
    const app = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/foia',
      headers: auth(user),
      payload: {
        workspaceId: user.workspaceId,
        jurisdictionId: oaklandId,
        subject: 'ALPR contracts and policies',
        body: 'Full request text here…',
      },
    });
    expect(created.statusCode).toBe(201);
    const foia = created.json();
    expect(foia.status).toBe('draft');

    // invalid: draft → appeal
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/foia/${foia.id}`,
      headers: auth(user),
      payload: { status: 'appeal' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toContain('Cannot move');

    const sent = await app.inject({
      method: 'PATCH',
      url: `/api/v1/foia/${foia.id}`,
      headers: auth(user),
      payload: { status: 'sent' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().sentAt).toBeTruthy();
    expect(sent.json().dueAt).toBeTruthy(); // statutory due date computed

    const ack = await app.inject({
      method: 'PATCH',
      url: `/api/v1/foia/${foia.id}`,
      headers: auth(user),
      payload: { status: 'acknowledged', foiaNumber: 'PRA-2026-0042' },
    });
    expect(ack.json().foiaNumber).toBe('PRA-2026-0042');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/foia/${foia.id}`,
      headers: auth(user),
      payload: { status: 'response', outcome: 'partial' },
    });
    expect(response.json().outcome).toBe('partial');

    const detail = await app.inject({ url: `/api/v1/foia/${foia.id}`, headers: auth(user) });
    expect(detail.json().statute.abbr).toBe('CA');
  });

  it('documents: upload, redaction annotations, delete; cross-workspace denied', async () => {
    const app = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/foia',
      headers: auth(user),
      payload: { workspaceId: user.workspaceId, subject: 'Doc holder', body: 'x'.repeat(30) },
    });
    const foiaId = created.json().id;

    const boundary = '----stnfoiab';
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/foia/${foiaId}/documents`,
      headers: { ...auth(user), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="response.txt"',
        'Content-Type: text/plain',
        '',
        'Agency response: 12 ALPR units active.',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().documentId;

    const redact = await app.inject({
      method: 'PATCH',
      url: `/api/v1/foia/${foiaId}/documents/${docId}`,
      headers: auth(user),
      payload: { redactions: [{ page: 1, note: 'names withheld b(6)' }] },
    });
    expect(redact.statusCode).toBe(200);

    const stranger = await createUser('editor');
    const denied = await app.inject({ url: `/api/v1/foia/${foiaId}`, headers: auth(stranger) });
    expect(denied.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/foia/${foiaId}/documents/${docId}`,
      headers: auth(user),
    });
    expect(del.statusCode).toBe(200);
  });

  it('deadline job notifies owners of approaching/overdue requests', async () => {
    const app = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/foia',
      headers: auth(user),
      payload: { workspaceId: user.workspaceId, subject: 'Deadline test request', body: 'body text here' },
    });
    const foiaId = created.json().id;
    await query(
      `UPDATE foia_requests SET status = 'sent', sent_at = now() - interval '20 days', due_at = now() - interval '2 days' WHERE id = $1`,
      [foiaId],
    );
    const { runScheduledJobNow } = await import('../src/jobs/scheduler.js');
    const result = (await runScheduledJobNow('foia_deadline_check')) as { reminded: number };
    expect(result.reminded).toBeGreaterThanOrEqual(1);

    const notif = await app.inject({ method: 'GET', url: '/api/v1/users/me/notifications', headers: auth(user) });
    expect(notif.json().items.some((n: { kind: string; link: string }) => n.kind === 'foia_deadline' && n.link === `/foia/${foiaId}`)).toBe(true);
  });
});

describe('policies', () => {
  it('CRUD + timeline comparison + full-text search', async () => {
    const app = await getApp();
    const editor = user;
    const cityA = await makeJurisdiction('Policy City A', 'city', 'California');
    const cityB = await makeJurisdiction('Policy City B', 'city', 'Texas');

    const p1 = await app.inject({
      method: 'POST',
      url: '/api/v1/policies',
      headers: auth(editor),
      payload: {
        jurisdictionId: cityA,
        title: 'Surveillance oversight ordinance',
        effectiveDate: '2023-04-01',
        content: 'Requires council approval for surveillance technology acquisitions and annual reporting.',
      },
    });
    expect(p1.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: '/api/v1/policies',
      headers: auth(editor),
      payload: {
        jurisdictionId: cityB,
        title: 'Facial recognition moratorium',
        effectiveDate: '2024-09-15',
        content: 'Prohibits municipal facial recognition use pending review.',
      },
    });

    const timeline = await app.inject({ url: `/api/v1/policies/timeline?jurisdictions=${cityA},${cityB}` });
    expect(timeline.json().items.length).toBe(2);
    expect(timeline.json().items[0].effectiveDate <= timeline.json().items[1].effectiveDate).toBe(true);

    const search = await app.inject({ url: '/api/v1/policies?q=moratorium' });
    expect(search.json().items.some((p: { title: string }) => p.title.includes('moratorium'))).toBe(true);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/policies/${p1.json().id}`,
      headers: auth(editor),
      payload: { title: 'Surveillance oversight ordinance (amended)' },
    });
    expect(patch.json().title).toContain('amended');
  });
});
