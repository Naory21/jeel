// Send each claimed reminder to its phones. If no phone got it, release the claim so the next
// run (a minute later) retries; if at least one did, keep it claimed to avoid duplicates.
import type { NotificationChannel } from './channel.ts';

export interface ClaimedReminder {
  reminder_id: string;
  title: string;
  local_time: string;
  phones: string[] | null;
}

export interface DeliveryResult {
  claimed: number;
  sent: number;
  failed: number;
  released: string[];
  errors: string[];
}

// record(reminderId, ok, detail) writes the outcome to the audit trail; phone numbers are masked
export async function deliver(
  rows: ClaimedReminder[],
  channel: NotificationChannel,
  release: (reminderId: string) => Promise<unknown>,
  record: (reminderId: string, ok: boolean, detail: string) => Promise<unknown> = async () => {}
): Promise<DeliveryResult> {
  const out: DeliveryResult = { claimed: rows.length, sent: 0, failed: 0, released: [], errors: [] };
  for (const r of rows) {
    const phones = r.phones ?? [];
    let ok = 0;
    const notes: string[] = [];
    for (const phone of phones) {
      const masked = phone.slice(0, 5) + '…' + phone.slice(-2);
      try {
        await channel.send(phone, { reminderId: r.reminder_id, title: r.title, time: r.local_time });
        ok++;
        out.sent++;
        notes.push(`${masked} ✓`);
      } catch (e) {
        out.failed++;
        out.errors.push(`${r.reminder_id} → ${masked}: ${(e as Error).message}`);
        notes.push(`${masked} ✗ ${(e as Error).message}`);
      }
    }
    if (phones.length === 0) notes.push('no WhatsApp number on file');
    try { await record(r.reminder_id, ok > 0, notes.join('; ')); } catch { /* the audit write must not block delivery */ }
    if (phones.length > 0 && ok === 0) {
      await release(r.reminder_id);
      out.released.push(r.reminder_id);
    }
  }
  return out;
}
