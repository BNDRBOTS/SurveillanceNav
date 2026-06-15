import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Workspace, WorkspaceMember } from '@stn/shared';
import { get, post, del, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtDate } from '@/lib/format';
import { EmptyState, ErrorState, Skeleton } from '@/components/Feedback';
import { Modal, ConfirmDialog } from '@/components/Modal';
import { TextInput, Select } from '@/components/Form';

export function WorkspacesPage(): JSX.Element {
  const user = useStore((s) => s.user);
  const setWorkspaces = useStore((s) => s.setWorkspaces);
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const res = await get<{ items: Workspace[] }>('/workspaces');
      setWorkspaces(res.items);
      return res;
    },
    enabled: !!user,
  });

  if (!user) {
    return (
      <div className="page">
        <EmptyState title="Sign in to use workspaces" hint="Workspaces are shared spaces for teams: FOIA tracking, comments, saved views, and role-based permissions." action={<Link className="btn btn-primary" to="/login">Sign in</Link>} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workspaces</h1>
          <p className="text-sm text-secondary">Collaborate with viewer / editor / admin roles. Access is deny-by-default across workspaces.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          ＋ New workspace
        </button>
      </div>

      {isLoading ? (
        <Skeleton count={3} height={64} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (
        <div className="grid-2">
          {(data?.items ?? []).map((w) => (
            <button key={w.id} type="button" className="card col" style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--color-border)' }} onClick={() => navigate(`/workspaces/${w.id}`)}>
              <div className="row">
                <h2 style={{ flex: 1 }}>{w.name}</h2>
                <span className="pill" data-tone="accent">
                  {w.role}
                </span>
              </div>
              <span className="text-xs text-secondary">
                {w.memberCount} member{w.memberCount === 1 ? '' : 's'} · created {fmtDate(w.createdAt)}
              </span>
            </button>
          ))}
        </div>
      )}

      {createOpen ? (
        <CreateWorkspaceModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            navigate(`/workspaces/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const ws = await post<{ id: string }>('/workspaces', { name: name.trim() });
      toast('Workspace created.', 'success');
      onCreated(ws.id);
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New workspace"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Metro Surveillance Audit 2026" />
    </Modal>
  );
}

type WorkspaceDetail = Workspace & {
  members: WorkspaceMember[];
  pendingInvites: Array<{ id: string; email: string; role: string; expiresAt: string }>;
};

export function WorkspaceDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const user = useStore((s) => s.user);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceMember | null>(null);

  const { data: ws, isLoading, error, refetch } = useQuery({
    queryKey: ['workspace', id],
    queryFn: () => get<WorkspaceDetail>(`/workspaces/${id}`),
    enabled: !!id,
  });

  const myRole = ws?.members.find((m) => m.userId === user?.id)?.role ?? (user?.role === 'admin' ? 'admin' : 'viewer');
  const isAdmin = myRole === 'admin';

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await post<{ joined?: boolean; invited?: boolean }>(`/workspaces/${id}/members`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      toast(res.joined ? 'Member added — they have access now.' : 'Invitation emailed. It expires in 14 days.', 'success', 6000);
      setInviteEmail('');
      void refetch();
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="page">
        <Skeleton count={6} height={32} />
      </div>
    );
  }
  if (error || !ws) {
    return (
      <div className="page">
        <ErrorState message={(error as Error | null)?.message ?? 'Workspace not found'} onRetry={() => void refetch()} />
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <div className="col" style={{ gap: 4 }}>
          <Link to="/workspaces" className="text-sm text-secondary">
            ← All workspaces
          </Link>
          <h1>{ws.name}</h1>
        </div>
        {ws.ownerId === user?.id ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
            Delete workspace
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              try {
                await del(`/workspaces/${id}/members/${user?.id}`);
                toast('You left the workspace.', 'success');
                void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
                navigate('/workspaces');
              } catch (err) {
                toast((err as ApiError).message, 'error');
              }
            }}
          >
            Leave workspace
          </button>
        )}
      </div>

      <div className="card col" style={{ marginBottom: 'var(--space-lg)' }}>
        <h2>Members ({ws.members.length})</h2>
        {ws.members.map((m) => (
          <div key={m.userId} className="row" style={{ justifyContent: 'space-between' }}>
            <div className="col" style={{ gap: 0 }}>
              <span className="text-sm">
                {m.name} {m.userId === ws.ownerId ? <span className="pill" data-tone="accent">owner</span> : null}
              </span>
              <span className="text-xs text-secondary">{m.email}</span>
            </div>
            <div className="row">
              <span className="pill">{m.role}</span>
              {isAdmin && m.userId !== ws.ownerId && m.userId !== user?.id ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmRemove(m)} aria-label={`Remove ${m.name}`}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}

        {ws.pendingInvites.length > 0 ? (
          <>
            <hr className="divider" />
            <h3 className="text-sm text-secondary">Pending invites</h3>
            {ws.pendingInvites.map((inv) => (
              <div key={inv.id} className="row text-sm" style={{ justifyContent: 'space-between' }}>
                <span>{inv.email}</span>
                <span className="text-xs text-secondary">
                  {inv.role} · expires {fmtDate(inv.expiresAt)}
                </span>
              </div>
            ))}
          </>
        ) : null}

        {isAdmin ? (
          <>
            <hr className="divider" />
            <form className="row-wrap" style={{ alignItems: 'flex-end' }} onSubmit={invite}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <TextInput label="Invite by email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@newsroom.org" required />
              </div>
              <div style={{ minWidth: 140 }}>
                <Select label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} hint="Editors can create; admins manage members">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </Select>
              </div>
              <button className="btn btn-primary" disabled={busy || !inviteEmail.trim()} style={{ marginBottom: 'var(--space-md)' }}>
                {busy ? 'Inviting…' : 'Invite'}
              </button>
            </form>
          </>
        ) : null}
      </div>

      <div className="grid-3">
        <Link to="/foia" className="card stat-card" style={{ textDecoration: 'none' }}>
          <span className="text-sm text-secondary">FOIA requests</span>
          <span className="stat-value">→</span>
          <span className="text-xs text-secondary">Track this workspace's records requests</span>
        </Link>
        <Link to="/map" className="card stat-card" style={{ textDecoration: 'none' }}>
          <span className="text-sm text-secondary">Shared map views</span>
          <span className="stat-value">→</span>
          <span className="text-xs text-secondary">Saved views appear in the map's Views panel</span>
        </Link>
        <Link to="/reports" className="card stat-card" style={{ textDecoration: 'none' }}>
          <span className="text-sm text-secondary">Exports</span>
          <span className="stat-value">→</span>
          <span className="text-xs text-secondary">Generate workspace reports</span>
        </Link>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete "${ws.name}"?`}
          message="All members lose access. FOIA requests, comments and saved views in this workspace become unreachable. This cannot be undone."
          confirmLabel="Delete workspace"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await del(`/workspaces/${id}`);
              toast('Workspace deleted.', 'success');
              void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
              navigate('/workspaces');
            } catch (err) {
              toast((err as ApiError).message, 'error');
              setConfirmDelete(false);
            }
          }}
        />
      ) : null}
      {confirmRemove ? (
        <ConfirmDialog
          title={`Remove ${confirmRemove.name}?`}
          message={`${confirmRemove.email} will immediately lose access to this workspace's FOIA requests, comments, and views.`}
          confirmLabel="Remove member"
          destructive
          onCancel={() => setConfirmRemove(null)}
          onConfirm={async () => {
            try {
              await del(`/workspaces/${id}/members/${confirmRemove.userId}`);
              toast('Member removed.', 'success');
              setConfirmRemove(null);
              void refetch();
            } catch (err) {
              toast((err as ApiError).message, 'error');
              setConfirmRemove(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}
