// Explicit, local-only sample data. Never imports or calls a remote storage API.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:5173';
const status = await fetch(`${origin}/api/v1/setup/status`).then((r) =>
  r.json(),
);
if (!status.hasOwner) {
  const setupToken = readFileSync('.dev.vars', 'utf8')
    .match(/^SETUP_TOKEN=(.+)$/m)?.[1]
    .trim();
  const response = await fetch(`${origin}/api/v1/setup/claim`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      setupToken,
      username: 'demo',
      name: 'Alex Morgan',
      recoveryEmail: 'alex@external.example',
      password: 'Local demo password 123!',
      timezone: 'Europe/London',
    }),
  });
  if (!response.ok) throw new Error(`Local claim failed: ${response.status}`);
  console.log('Local demo account: demo / Local demo password 123!');
}
const explorer = `${origin}/cdn-cgi/local/explorer/api`;
async function query(data) {
  const response = await fetch(`${explorer}/d1/database/DB/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new Error(JSON.stringify(result.errors));
  return result.result.map((r) => ({
    results: r.results.rows.map((row) =>
      Object.fromEntries(r.results.columns.map((name, i) => [name, row[i]])),
    ),
  }));
}
const db = {
  prepare(sql) {
    return {
      sql,
      params: [],
      bind(...params) {
        this.params = params.map(String);
        return this;
      },
      async first() {
        return (
          (await query({ sql: this.sql, params: this.params }))[0].results[0] ||
          null
        );
      },
      async run() {
        return query({ sql: this.sql, params: this.params });
      },
    };
  },
  async batch(statements) {
    return query({
      batch: statements.map(({ sql, params }) => ({ sql, params })),
    });
  },
};
const files = {
  async put(key, value, options) {
    const response = await fetch(
      `${explorer}/r2/buckets/yougotmail-files/objects/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': options.httpMetadata.contentType },
        body: value,
      },
    );
    if (!response.ok) throw new Error('Local R2 upload failed');
  },
};
{
  if (
    await db
      .prepare("SELECT 1 FROM settings WHERE key='local_demo_seed'")
      .first()
  ) {
    console.log('Local samples already exist.');
    process.exitCode = 0;
  } else {
    const user = await db
      .prepare("SELECT id FROM users WHERE role='owner'")
      .first();
    if (!user)
      throw new Error('No owner found. Run npm run setup:local first.');
    const domain = randomUUID(),
      second = randomUUID(),
      personal = randomUUID(),
      team = randomUUID(),
      timestamp = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO domains(id,name,zone_id,provider,receiving_status,sending_status,created_at) VALUES(?,?,?,'cloudflare','ready','ready',?)",
        )
        .bind(domain, 'morgan.example', 'local', timestamp),
      db
        .prepare(
          "INSERT INTO domains(id,name,zone_id,provider,receiving_status,sending_status,created_at) VALUES(?,?,?,'resend','ready','ready',?)",
        )
        .bind(second, 'studio.example', 'local', timestamp),
      db
        .prepare(
          "INSERT INTO mailboxes(id,name,kind,primary_address,created_at) VALUES(?,?,'private',?,?)",
        )
        .bind(personal, 'Personal', 'alex@morgan.example', timestamp),
      db
        .prepare(
          "INSERT INTO mailboxes(id,name,kind,primary_address,created_at) VALUES(?,?,'shared',?,?)",
        )
        .bind(team, 'The studio', 'hello@studio.example', timestamp),
      ...[personal, team].map((id) =>
        db.prepare('INSERT INTO mailbox_members VALUES(?,?)').bind(id, user.id),
      ),
      ...[
        [personal, domain, 'alex@morgan.example', 'Alex Morgan'],
        [personal, domain, 'notes@morgan.example', 'Alex'],
        [team, second, 'hello@studio.example', 'The studio'],
      ].map((a) =>
        db
          .prepare(
            'INSERT INTO addresses(id,mailbox_id,domain_id,email,name) VALUES(?,?,?,?,?)',
          )
          .bind(randomUUID(), ...a),
      ),
      db.prepare("INSERT INTO settings VALUES('local_demo_seed','true')"),
    ]);
    const labels = [
      ['Friends', '#b68c61'],
      ['Projects', '#668ba0'],
      ['Good reads', '#8b8c5e'],
    ].map(([name, color]) => ({ id: randomUUID(), name, color }));
    for (const l of labels)
      await db
        .prepare('INSERT INTO labels VALUES(?,?,?,?)')
        .bind(l.id, personal, l.name, l.color)
        .run();
    const samples = [
      [
        'Olivia Chen',
        'olivia@friends.example',
        'A little adventure this weekend?',
        'I found a lovely walking route by the coast. A picnic, a good book, and absolutely no plans. Are you in?',
        20,
        0,
      ],
      [
        'Daniel Wright',
        'daniel@studio.example',
        'The new brand direction',
        'The moodboards are looking good. I especially like the warmer colours and the quieter typography. Let’s catch up tomorrow.',
        55,
        1,
      ],
      [
        'The Reading Room',
        'weekly@reading.example',
        'Three things worth reading',
        'A small collection of thoughtful writing for your Tuesday. Put the kettle on, find a comfortable chair, and take your time.',
        130,
        2,
      ],
      [
        'Mia Patel',
        'mia@friends.example',
        'Coffee next week?',
        'There is a new little place on the corner. Their cinnamon buns are supposed to be incredible. Tuesday morning?',
        200,
        0,
      ],
      [
        'Studio North',
        'team@north.example',
        'Your project is ready for a first look',
        'We have put the first round together and would love your thoughts. Everything is in a good place for the review on Thursday.',
        300,
        1,
      ],
      [
        'Elliot James',
        'elliot@friends.example',
        'Photos from Sunday',
        'Such a lovely afternoon. I will send you the rest of the photos once I have had a chance to sort through them.',
        700,
        0,
      ],
      [
        'Avery Stone',
        'avery@work.example',
        'A few thoughts on the launch',
        'Keep it simple. Tell a clear story, give people a good first experience, and let the product speak for itself.',
        1000,
        1,
      ],
      [
        'Garden Notes',
        'hello@garden.example',
        'A quieter corner of the internet',
        'This month: growing herbs on a windowsill, making room for small rituals, and remembering to slow down.',
        1300,
        2,
      ],
      [
        'Sam Rivera',
        'sam@friends.example',
        'That book you mentioned',
        'I finally started it last night and could not put it down. You were right about the first chapter.',
        1700,
        0,
      ],
      [
        'Harper Ellis',
        'harper@studio.example',
        'Welcome to the studio',
        'So glad to have you here. Our shared inbox is ready for your team, and every alias has a home.',
        1900,
        -1,
      ],
    ];
    let used = 0;
    for (const [index, s] of samples.entries()) {
      const [name, email, subject, text, minutes, label] = s,
        mailbox = label === -1 ? team : personal,
        recipient =
          label === -1 ? 'hello@studio.example' : 'alex@morgan.example',
        thread = randomUUID(),
        message = randomUUID(),
        key = `bodies/${mailbox}/${message}.json`,
        date = timestamp - minutes * 60_000,
        participants = JSON.stringify([
          { name, address: email },
          { name: 'Alex Morgan', address: recipient },
        ]);
      await files.put(
        key,
        JSON.stringify({
          html: `<p>Hi Alex,</p><p>${text}</p><p>Take care,<br>${name}</p>`,
          text: `Hi Alex,\n\n${text}\n\nTake care,\n${name}`,
        }),
        { httpMetadata: { contentType: 'application/json' } },
      );
      const statements = [
        db
          .prepare(
            'INSERT INTO threads(id,mailbox_id,subject,snippet,participants,updated_at,unread,starred,folder,count) VALUES(?,?,?,?,?,?,?,?,?,1)',
          )
          .bind(
            thread,
            mailbox,
            subject,
            text,
            participants,
            date,
            index < 3 ? 1 : 0,
            index === 0 || index === 4 ? 1 : 0,
            'inbox',
          ),
        db
          .prepare(
            'INSERT INTO messages(id,thread_id,mailbox_id,direction,from_address,from_name,to_json,subject,date,internet_id,body_key,size,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            message,
            thread,
            mailbox,
            'incoming',
            email,
            name,
            JSON.stringify([{ address: recipient }]),
            subject,
            date,
            `<${message}@local.example>`,
            key,
            text.length,
            `seed:${message}`,
          ),
        db
          .prepare('INSERT INTO search_chunks VALUES(?,?,?,?,?)')
          .bind(message, mailbox, subject, `${email} ${name}`, text),
        db
          .prepare('UPDATE mailboxes SET used_bytes=used_bytes+? WHERE id=?')
          .bind(text.length, mailbox),
      ];
      if (label >= 0)
        statements.push(
          db
            .prepare('INSERT INTO thread_labels VALUES(?,?)')
            .bind(thread, labels[label].id),
        );
      await db.batch(statements);
      used++;
    }
    const brand = JSON.parse(
      (
        await db
          .prepare("SELECT value FROM settings WHERE key='branding'")
          .first()
      ).value,
    );
    brand.setup_complete = true;
    await db
      .prepare("UPDATE settings SET value=? WHERE key='branding'")
      .bind(JSON.stringify(brand))
      .run();
    await db
      .prepare('INSERT INTO contacts VALUES(?,?,?,?,?)')
      .bind(
        randomUUID(),
        user.id,
        'Olivia Chen',
        'olivia@friends.example',
        'A good friend.',
      )
      .run();
    console.log(
      `Created ${used} sample conversations, two mailboxes, three aliases, labels and a contact in local storage. No integration credentials or external mail sending are configured.`,
    );
  }
}
