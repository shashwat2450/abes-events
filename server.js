const express = require('express'), path = require('path'), crypto = require('crypto');
const { MongoClient } = require('mongodb');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD, MONGODB_URI = process.env.MONGODB_URI;
if (!ADMIN_PASSWORD || !MONGODB_URI) { console.error('Set the ADMIN_PASSWORD and MONGODB_URI environment variables.'); process.exit(1); }

const seed = [
  { id: 1, name: 'Kalakrit', category: 'Cultural', date: '2026-10-17T17:00', venue: 'Auditorium', featured: true, description: 'A stage for art, music, dance and performance by the most creative people on campus.' },
  { id: 2, name: 'Genero', category: 'Sports', date: '2026-11-07T10:00', venue: 'College Ground', featured: false, description: 'A day of games and friendly competition out on the ground.' },
  { id: 3, name: 'ABES Got Latent', category: 'Entertainment', date: '2026-11-21T18:00', venue: 'Auditorium', featured: false, description: 'A talent and comedy show where ABES students take the mic.' }
];
let events, regs, meta;
const NO_ID = { projection: { _id: 0 } };
const nextId = async () => (await meta.findOneAndUpdate({ _id: 'counter' }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' })).n;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const tokens = new Map();
const clean = v => String(v ?? '').trim();
const fail = (res, code, error) => res.status(code).json({ error });
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); fail(res, 500, 'Server error. Try again.'); });
const auth = (req, res, next) => tokens.get((req.headers.authorization || '').replace('Bearer ', '')) > Date.now() ? next() : fail(res, 401, 'Please log in again.');
const eventFields = b => {
  const e = { name: clean(b.name), category: clean(b.category), date: clean(b.date), venue: clean(b.venue), description: clean(b.description), featured: !!b.featured };
  return e.name && e.category && e.venue && !isNaN(Date.parse(e.date)) ? e : null;
};

// ---------- public API ----------
app.get('/api/events', h(async (req, res) => {
  const q = clean(req.query.q), cat = clean(req.query.category);
  res.json(await events.find({ ...(cat && { category: cat }), ...(q && { name: { $regex: escRe(q), $options: 'i' } }) }, NO_ID).sort({ date: 1 }).toArray());
}));
app.get('/api/categories', h(async (req, res) => res.json((await events.distinct('category')).sort())));
app.get('/api/events/:id', h(async (req, res) => {
  const ev = await events.findOne({ id: Number(req.params.id) }, NO_ID);
  ev ? res.json(ev) : fail(res, 404, 'Event not found.');
}));

app.post('/api/events/:id/register', h(async (req, res) => {
  const ev = await events.findOne({ id: Number(req.params.id) }, NO_ID);
  if (!ev) return fail(res, 404, 'Event not found.');
  const r = { name: clean(req.body.name), email: clean(req.body.email).toLowerCase(), college: clean(req.body.college), phone: clean(req.body.phone).replace(/[\s-]/g, '') };
  if (r.name.length < 2 || r.college.length < 2) return fail(res, 400, 'Enter your name and your college and year.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) return fail(res, 400, 'Enter a valid email address.');
  if (!/^(\+91)?[6-9]\d{9}$/.test(r.phone)) return fail(res, 400, 'Enter a valid 10-digit phone number.');
  try { await regs.insertOne({ id: await nextId(), eventId: ev.id, ...r, createdAt: new Date().toISOString() }); }
  catch (e) { if (e.code === 11000) return fail(res, 409, 'This email is already registered for this event.'); throw e; }
  res.status(201).json({ ok: true });
}));

// ---------- admin API ----------
app.post('/api/admin/login', (req, res) => {
  const a = Buffer.from(clean(req.body.password)), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 401, 'Wrong password.');
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + 8 * 3600e3);
  res.json({ token });
});

app.post('/api/admin/events', auth, h(async (req, res) => {
  const e = eventFields(req.body);
  if (!e) return fail(res, 400, 'Name, category, date and venue are required.');
  const ev = { id: await nextId(), ...e };
  await events.insertOne({ ...ev });
  res.status(201).json(ev);
}));

app.put('/api/admin/events/:id', auth, h(async (req, res) => {
  const e = eventFields(req.body);
  if (!e) return fail(res, 400, 'Name, category, date and venue are required.');
  const ev = await events.findOneAndUpdate({ id: Number(req.params.id) }, { $set: e }, { returnDocument: 'after', ...NO_ID });
  ev ? res.json(ev) : fail(res, 404, 'Event not found.');
}));

app.delete('/api/admin/events/:id', auth, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await events.deleteOne({ id })).deletedCount) return fail(res, 404, 'Event not found.');
  await regs.deleteMany({ eventId: id });
  res.json({ ok: true });
}));

app.get('/api/admin/registrations', auth, h(async (req, res) => {
  const q = clean(req.query.q), eventId = Number(req.query.eventId) || 0, rx = { $regex: escRe(q), $options: 'i' };
  const filter = { ...(eventId && { eventId }), ...(q && { $or: ['name', 'email', 'college', 'phone'].map(f => ({ [f]: rx })) }) };
  const names = Object.fromEntries((await events.find({}, NO_ID).toArray()).map(e => [e.id, e.name]));
  const list = await regs.find(filter, NO_ID).sort({ createdAt: -1 }).toArray();
  res.json(list.map(r => ({ ...r, eventName: names[r.eventId] || 'Deleted event' })));
}));

app.delete('/api/admin/registrations/:id', auth, h(async (req, res) => {
  await regs.deleteOne({ id: Number(req.params.id) });
  res.json({ ok: true });
}));

app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

// ---------- start ----------
(async () => {
  const client = await new MongoClient(MONGODB_URI).connect();
  const db = client.db();
  events = db.collection('events'); regs = db.collection('registrations'); meta = db.collection('meta');
  await regs.createIndex({ eventId: 1, email: 1 }, { unique: true });
  if (!(await meta.findOne({ _id: 'counter' }))) { await events.insertMany(seed); await meta.insertOne({ _id: 'counter', n: 3 }); }
  app.listen(PORT, () => console.log(`ABES EVENTS running on port ${PORT}`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
