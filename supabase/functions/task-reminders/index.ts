// Supabase Edge Function: task-reminders
//
// Вызывается периодически по расписанию (см. SETUP.md, раздел про cron).
// Находит задачи (tasks с kind='задача'), у которых наступил срок (due_date),
// они ещё не выполнены и напоминание по ним ещё не отправлялось —
// и шлёт сообщение в Telegram владельцу CRM (chat_id берётся из таблицы
// settings, которую заполняет само мини-приложение при каждом открытии).
//
// Деплой:
//   supabase functions deploy task-reminders
//   (либо через Supabase Dashboard -> Edge Functions -> Deploy new function)
//
// Секреты, которые нужны функции (Project Settings -> Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN — токен вашего бота от @BotFather
//   (SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY уже доступны автоматически)
//
// Вызывать эту функцию нужно по расписанию каждые 5-10 минут — см. SETUP.md.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function fmtDateTime(iso: string) {
  const dt = new Date(iso);
  return dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
    dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

async function sendTelegramMessage(chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: settingsRow } = await supabase.from('settings').select('owner_chat_id').eq('id', 1).single();
    const ownerChatId = settingsRow?.owner_chat_id;

    if (!ownerChatId) {
      return new Response(JSON.stringify({ ok: false, reason: 'owner_chat_id не найден — откройте мини-апп в Telegram хотя бы раз' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nowIso = new Date().toISOString();

    // Только обычные задачи (kind = 'задача') — встречи синхронизируются
    // с Google Calendar и напоминания там даёт сам календарь.
    const { data: dueTasks, error } = await supabase
      .from('tasks')
      .select('id, title, due_date, contact_id')
      .eq('kind', 'задача')
      .eq('completed', false)
      .eq('reminder_sent', false)
      .lte('due_date', nowIso);

    if (error) throw error;
    if (!dueTasks || !dueTasks.length) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const contactIds = [...new Set(dueTasks.map((t) => t.contact_id).filter(Boolean))];
    let contactsById: Record<string, string> = {};
    if (contactIds.length) {
      const { data: contacts } = await supabase.from('contacts').select('id, name').in('id', contactIds);
      (contacts || []).forEach((c: any) => { contactsById[c.id] = c.name; });
    }

    let sent = 0;
    for (const t of dueTasks) {
      const contactName = t.contact_id ? contactsById[t.contact_id] : null;
      const text = `⏰ <b>Напоминание о задаче</b>\n${t.title}${contactName ? '\nКлиент: ' + contactName : ''}\nСрок: ${fmtDateTime(t.due_date)}`;
      const res = await sendTelegramMessage(ownerChatId, text);
      if (res.ok) {
        await supabase.from('tasks').update({ reminder_sent: true }).eq('id', t.id);
        sent++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
