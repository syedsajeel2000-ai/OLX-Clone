// Bazaarly — OLX-inspired marketplace. Express + better-sqlite3 + EJS + express-session (SQLite store).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');

// load .env before anything reads process.env
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  });
})();

const { db, migrate, DB_PATH } = require('./db/db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'bazaarly-dev-secret-change-me';

migrate(); // idempotent — creates tables if they don't exist

// Seed automatically on first run (empty categories table = fresh database).
// Set SEED_TARGET=0 to disable auto-seeding entirely.
const catCount = db.prepare(`SELECT COUNT(*) c FROM categories`).get().c;
if (catCount === 0 && process.env.SEED_TARGET !== '0') {
  console.log('Empty database detected — seeding demo data...');
  require('./scripts/seed');
}

// ---------- view engine & static ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// uploads dir for user-posted images (UPLOAD_DIR overridable on ephemeral hosts)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- sessions (stored in SQLite: data/sessions.db) ----------
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.DATA_DIR || path.join(__dirname, 'data'), }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

// ---------- template helpers available in every view ----------
Object.assign(app.locals, require('./lib/helpers'));

// ---------- make user/unread/categories available in every template ----------
const { currentUser, unreadCount, resolveTheme } = require('./middleware/auth');
app.use((req, res, next) => {
  res.locals.user = currentUser(req);
  res.locals.unread = res.locals.user ? unreadCount(res.locals.user.id) : 0;
  res.locals.allCategories = db.prepare(`SELECT id, name FROM categories ORDER BY name`).all();
  res.locals.currentPath = req.path;
  res.locals.theme = resolveTheme(req, res.locals.user, res); // 'light' | 'dark'
  next();
});

// theme toggle (works for guests via cookie and users via DB + cookie)
app.post('/api/theme', (req, res) => {
  const theme = req.body && req.body.theme;
  if (theme !== 'dark' && theme !== 'light') return res.status(400).json({ error: 'Invalid theme.' });
  if (res.locals.user) {
    db.prepare(`UPDATE users SET theme = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(theme, res.locals.user.id);
  }
  res.cookie('theme', theme, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ ok: true, theme });
});

// ---------- routes ----------
const pagesRouter = require('./routes/pages');
const apiRouter = require('./routes/api');

// Multer upload handling for the two ad forms (parsed before page routes)
const multerMid = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'));
  },
}).array('images', 8);

function saveUploads(req, res) {
  return new Promise((resolve) => {
    multerMid(req, res, (err) => resolve(err || null));
  });
}

function writeUploadFiles(req) {
  const saved = [];
  (req.files || []).forEach((file) => {
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype] || '.jpg';
    const name = `${crypto.randomBytes(8).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
    saved.push(`/uploads/${name}`);
  });
  return saved;
}

const { validateListing } = require('./lib/helpers');

async function handleAdForm(req, res, existing) {
  const uploadErr = await saveUploads(req, res);
  const form = {
    title: String(req.body.title || '').trim(),
    description: String(req.body.description || '').trim(),
    category_id: parseInt(req.body.category_id, 10),
    price: parseFloat(req.body.price),
    condition: String(req.body.condition || '').trim(),
    city: String(req.body.city || '').trim(),
    area: String(req.body.area || '').trim(),
    phone: String(req.body.phone || '').trim(),
    negotiable: req.body.negotiable ? 1 : 0,
    additional_details: String(req.body.additional_details || '').trim(),
  };

  let errors = [];
  if (uploadErr) {
    errors.push(uploadErr.message || 'Image upload failed.');
  } else {
    errors = validateListing(form).errors;
  }

  const keepImages = existing
    ? (req.body.keep_images ? [].concat(req.body.keep_images) : [])
    : [];
  const newImages = uploadErr ? [] : writeUploadFiles(req);
  const totalImages = keepImages.length + newImages.length;

  // At least one image required for normal listings
  if (!errors.length && totalImages === 0) errors.push('Please upload at least one image.');

  const cats = db.prepare(`SELECT id, name FROM categories ORDER BY name`).all();
  const CITIES = ['Karachi','Lahore','Islamabad','Rawalpindi','Faisalabad','Multan','Peshawar','Quetta','Sialkot','Gujranwala'];
  const CONDITIONS = ['New', 'Used'];

  if (errors.length) {
    // clean up freshly written files if validation failed
    if (uploadErr) { /* nothing written */ } else { /* files kept so user doesn't lose previews? No — re-upload */ }
    newImages.forEach((p) => { try { fs.unlinkSync(path.join(__dirname, p)); } catch (e) {} });
    return res.status(400).render('post-ad', {
      user: res.locals.user, unread: res.locals.unread, cats, cities: CITIES, CONDITIONS,
      errors, form, title: existing ? 'Edit Ad' : 'Post Ad', isEdit: !!existing, listingId: existing ? existing.id : null,
      images: existing ? db.prepare(`SELECT id, image_url FROM listing_images WHERE listing_id = ? ORDER BY sort_order, id`).all(existing.id) : [],
    });
  }

  const isEdit = !!existing;
  if (isEdit) {
    db.prepare(`UPDATE listings SET title=?, description=?, category_id=?, price=?, condition=?, city=?, area=?, phone=?, negotiable=?, additional_details=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND seller_id=?`)
      .run(form.title, form.description, form.category_id, form.price, form.condition, form.city, form.area, form.phone, form.negotiable, form.additional_details, existing.id, req.session.userId);
    db.prepare(`DELETE FROM listing_images WHERE listing_id = ?`).run(existing.id);
    const finalImages = totalImages > 0 ? [...keepImages, ...newImages] : [];
    const ins = db.prepare(`INSERT INTO listing_images (listing_id, image_url, sort_order) VALUES (?,?,?)`);
    finalImages.forEach((url, i) => ins.run(existing.id, url, i));
    return res.redirect(`/listing/${existing.id}`);
  }

  const info = db.prepare(`INSERT INTO listings (seller_id, title, description, category_id, price, condition, city, area, phone, negotiable, additional_details, status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE')`)
    .run(req.session.userId, form.title, form.description, form.category_id, form.price, form.condition, form.city, form.area, form.phone, form.negotiable, form.additional_details);
  const listingId = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO listing_images (listing_id, image_url, sort_order) VALUES (?,?,?)`);
  finalImageList([...newImages], listingId);
  res.redirect(`/listing/${listingId}`);
}

function finalImageList(images, listingId) {
  const ins = db.prepare(`INSERT INTO listing_images (listing_id, image_url, sort_order) VALUES (?,?,?)`);
  images.forEach((url, i) => ins.run(listingId, url, i));
}

app.post('/post-ad', (req, res) => handleAdForm(req, res, null));
app.post('/edit-ad/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM listings WHERE id = ? AND seller_id = ? AND status != 'DELETED'`).get(req.params.id, req.session.userId);
  if (!existing) return res.status(404).send('Listing not found');
  handleAdForm(req, res, existing);
});

app.use('/api', apiRouter);
app.use('/', pagesRouter);

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Internal server error.' });
  res.status(500).send('Internal server error. Please try again.');
});

// Start the HTTP server only when run directly (node server.js).
// On serverless hosts (Vercel) api/index.js imports `app` as the request handler.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nBazaarly marketplace running → http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(`Demo login: sajeel@example.com / Password123\n`);
  });
}

module.exports = app;
