// How reminders reach a phone. WhatsApp in production; "log" for local testing.
// Kept behind one small interface so a different channel (e.g. Telegram) is a one-file change.

export interface ReminderMessage {
  reminderId: string;
  title: string;
  time: string; // "HH:MM", Asia/Jerusalem
}

export interface NotificationChannel {
  send(phone: string, msg: ReminderMessage): Promise<void>;
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  template: string;
  language: string;
  apiVersion: string;
}

// template parameters may not contain newlines, tabs or long runs of spaces
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

// "household_reminder" template: body "⏰ תזכורת: {{1}} / לשעה {{2}}", quick replies בוצע / עוד 30 דק׳
export function buildTemplateMessage(phone: string, msg: ReminderMessage, template: string, language: string) {
  return {
    messaging_product: 'whatsapp',
    to: phone.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: template,
      language: { code: language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: oneLine(msg.title) }, { type: 'text', text: msg.time }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `done:${msg.reminderId}` }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `snooze:${msg.reminderId}` }] }
      ]
    }
  };
}

export class WhatsAppChannel implements NotificationChannel {
  cfg: WhatsAppConfig;
  fetchFn: typeof fetch;

  constructor(cfg: WhatsAppConfig, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  async send(phone: string, msg: ReminderMessage): Promise<void> {
    const { phoneNumberId, accessToken, template, language, apiVersion } = this.cfg;
    const res = await this.fetchFn(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemplateMessage(phone, msg, template, language))
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export class LogChannel implements NotificationChannel {
  sent: { phone: string; msg: ReminderMessage }[] = [];
  async send(phone: string, msg: ReminderMessage): Promise<void> {
    this.sent.push({ phone, msg });
    console.log(`[reminder] ${phone} ← ${msg.title} @ ${msg.time}`);
  }
}

export function channelFromEnv(env: (key: string) => string | undefined): NotificationChannel {
  if ((env('NOTIFY_CHANNEL') || 'whatsapp') === 'log') return new LogChannel();
  const need = (k: string) => {
    const v = env(k);
    if (!v) throw new Error(`missing secret ${k}`);
    return v;
  };
  return new WhatsAppChannel({
    phoneNumberId: need('WHATSAPP_PHONE_NUMBER_ID'),
    accessToken: need('WHATSAPP_ACCESS_TOKEN'),
    template: env('WHATSAPP_TEMPLATE_NAME') || 'household_reminder',
    language: env('WHATSAPP_TEMPLATE_LANG') || 'he',
    apiVersion: env('WHATSAPP_API_VERSION') || 'v21.0'
  });
}
