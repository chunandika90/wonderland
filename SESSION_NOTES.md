# Session Recap — Wonderland (2026-08-31 → 2026-09-02)

## Masalah awal
`wccn.co.id/wonderland` cuma nampilin raw directory listing — app-nya belum pernah didaftarin sebagai Node.js App di cPanel sama sekali.

## Yang diperbaiki

### 1. Node.js App belum terdaftar
User daftarin lewat cPanel → Setup Node.js App → Create Application (root `public_html/wonderland`, startup file `server.js`). Setelah ini domain berubah dari directory listing jadi 404 — progress, tapi belum jalan sepenuhnya.

### 2. `.htaccess` konflik dua app dalam satu file
`public_html/wonderland/.htaccess` ternyata masih nyimpen blok Passenger config lama punya `compass` (karena kode wonderland ini asalnya dari codebase compass — lihat `package.json` name: `buranchi-compass`), ketimpa/ketambahan blok baru punya `wonderland`. Dua `PassengerAppRoot`/`PassengerBaseURI` beda app dalam satu `.htaccess` bikin LiteSpeed Passenger bingung routing-nya → 404.

**Fix:** hapus blok `compass` yang nyasar, sisain cuma blok `wonderland`.

### 3. `BASE_PATH` env var belum di-set
App-nya sendiri sebenernya udah support base path (`BASE_PATH` env var, dipakai buat redirect & asset path pas di-mount di subfolder kayak `/wonderland`), tapi env var-nya belum pernah diisi di cPanel Node App config → default ke `/`, jadinya semua redirect (`res.redirect(BASE_PATH_SLASH + 'login.html')`) ngarah ke `/login.html` (404) bukan `/wonderland/login.html`.

**Fix:** tambahin env var `BASE_PATH=/wonderland` di cPanel → Setup Node.js App → Environment Variables, lalu restart.

Setelah tiga fix ini, `wccn.co.id/wonderland` jalan normal dan redirect ke halaman login dengan benar.

## Bridge ke Sakara Ops
Wonderland dan Sakara Ops jalan di satu cPanel account yang sama tapi app terpisah. Sakara Ops sync data client-nya ke sini lewat `/api/bridge/orgs/*` (lihat `SAKARA_BRIDGE_SECRET` di `server.js`), supaya tiap client Sakara otomatis punya org/workspace di sini buat data kompetitor.

**Ditemukan bug besar di sisi Sakara:** default URL bridge-nya nunjuk ke `https://wccn.co.id/compass` (app lama yang mau dihapus), bukan ke `/wonderland` — jadi selama ini sync-nya selalu gagal diam-diam. Sudah diperbaiki di sisi Sakara (lihat repo `sakara`, `SESSION_NOTES.md` di situ) dan di-backfill manual lewat bridge API untuk 8 client asli:
`sakara-blueprints-bites-brew`, `sakara-buranchi`, `sakara-iga-tech-lifestyle`, `sakara-owiu-goods`, `sakara-by-bitte`, `sakara-sama-sama-prime`, `sakara-aquasonic`, `sakara-brown-butter`.

## Cleanup workspace list
Beberapa org di `data/orgs.json` ternyata data tes lama yang nggak match client Sakara mana pun — dinonaktifkan (`active: false`, bukan dihapus permanen, biar aman) via bridge PATCH:
`sakara` (Sakara Collectives), `bbb`, `sakara-unique-new-test-client`, `sakara-isolation-test-a`, `sakara-isolation-test-b`, `sakara-test-auto-login-client`.

`sakara-buranchi` **sengaja dibiarkan aktif** meski keliatan mirip "duplikat" dari `buranchi` — itu bukan sampah, itu slug yang dipakai bridge kompetitor Sakara Ops buat client Buranchi, beda dari workspace `buranchi` yang isinya konten planning asli (punya `apifyToken`, `geminiApiKey`, competitor list sendiri).

## File sensitif — TIDAK di-commit ke repo ini
`.env`, `.env.cpanel` (kredensial FTP/cPanel), `data/` (berisi `internal-users.json` — password plaintext staff — dan `orgs.json` — API key Apify & Gemini), `service-accounts/wonderland-drive-reader.json` (kredensial Google service account). Semua sudah di-`.gitignore`.

## Master Config: dari 1 file besar jadi list add/edit per kategori (2026-09-02)
Sebelumnya tiap kategori (Brand Context, Brand Voice, Brand Visual Identity, Ideal Customer Profile, Wonderland Assistant Instructions) adalah 1 file `.md` yang di-edit sebagai satu blok teks besar. Diubah jadi model list: tiap kategori punya banyak **entry** kecil yang bisa ditambah/edit/hapus satu-satu, masing-masing berupa teks (judul + isi) atau attachment gambar.

- **Data model**: `data/orgs/<slug>/config/<id>.entries.json` — array of `{id, type:'text'|'file', title, content|mimeType+data, createdAt}`. File `.md` lama tetap ada dan tetap yang dibaca semua kode AI-generation lain di app ini (content plan, campaign brief, chat, dst) — sekarang auto-di-regenerate (concatenated dari entries) tiap kali ada entry ditambah/edit/hapus, jadi tidak ada kode lain yang perlu diubah.
- **Migrasi otomatis**: kategori yang belum pernah dibuka lewat UI baru ini akan migrasi kontennya jadi 1 entry "Original content" saat pertama kali dibuka — tidak ada data hilang.
- **Kasus khusus Buranchi**: 4 dari 5 kategori Buranchi (semua kecuali Brand Visual Identity) `useSharedConfig: true` — dibaca dari file eksternal di luar folder Wonderland (kemungkinan dikelola manual oleh tim lain). Begitu satu entry ditambah/diedit lewat UI baru untuk salah satu dari 4 itu, kategori itu **"fork"** jadi file lokal Wonderland sendiri (`resolveConfigPath` cek: kalau `<id>.entries.json` sudah ada secara lokal, pakai itu, bukan file eksternal lagi) — file eksternal aslinya tidak pernah ditimpa, tapi juga berhenti nyambung begitu di-fork.
- **Update History** (halaman baru di sidebar Master Config): log kronologis semua transaksi (tiap `text added/updated/removed` atau `image added/removed`) lintas 5 kategori, dibatasi 30 entry terakhir per client (`data/orgs/<slug>/master-config-history.json`). Klik satu entry di list kiri nampilin isi lengkapnya di kanan (isi teks versi itu, atau preview gambarnya).
- **Brand Summary** (kartu AI di Dashboard, dibuat lebih awal sesi ini): sekarang narik gambar attachment dari kelima kategori itu juga (bukan cuma dari bucket generik `brand-assets.json` yang sempat dibuat lalu di-deprecate UI-nya karena kepakai attachment per-kategori).

### Layout final tiap halaman kategori (3 pane)
Iterasi pertama menaruh semua entry sebagai kartu bertumpuk dengan textarea kecil — tidak kepakai. Layout finalnya:

1. **Kiri** (`.mc-split` kolom 300px) — list entry: judul, waktu, ikon 📝 untuk teks / thumbnail untuk gambar, plus tombol **+ Add**. Item yang dipilih di-highlight.
2. **Kanan** — isi entry yang dipilih: judul + textarea besar (min-height 400px) dengan tombol Save/Remove, atau preview gambar penuh untuk entry attachment. Klik **+ Add** mengubah pane ini jadi form entry baru (toggle Text / Attach image).
3. **Bawah, full width** — **AI Summary khusus section itu**: sintesis Gemini atas seluruh entry di list (teks + gambar), output `{overview, keyPoints[], gaps[]}` — `gaps` sengaja diminta supaya kontradiksi antar-entry dan hal penting yang belum ditulis ikut ketahuan. Di-cache per org+kategori di `data/orgs/<slug>/config/<id>.summary.json`, digenerate hanya saat tombol ditekan, dan otomatis ditandai **stale** ("ada isi yang berubah setelah ini") kalau ada entry dengan `createdAt`/`updatedAt` lebih baru dari `generatedAt`.

Endpoint: `GET/POST /api/config/:id/summary[/generate]`. Ini berbeda dan berdiri sendiri dari Brand Summary di Dashboard, yang merangkum kelima kategori sekaligus.

### "Attach context", bukan cuma gambar
Tombol attach awalnya berlabel "Attach image" dan cuma nerima gambar — padahal yang lebih sering diupload justru file `.md`. Sekarang labelnya **"Attach context"** (pasangannya "Tulis teks") dan nerima `.txt/.md/.markdown/.csv/.json` + gambar, multi-file sekaligus, pakai helper `readAttachmentFiles()` yang memang sudah dipakai Content Plan & Creative Chat.

Pembagiannya:
- **Dokumen teks** → dibaca isinya di client, disimpan sebagai entry `type:'text'` biasa dengan `source:'upload'` + `fileName`. Jadi isinya tetap bisa diedit di pane kanan, ikut ter-concat ke file `.md` yang dibaca semua AI-generation lain, dan ikut kebaca AI summary sebagai teks beneran — bukan blob buram.
- **Gambar** → tetap entry `type:'file'` (base64) untuk preview dan dikirim sebagai `inlineData` waktu generate summary.

Di list kiri: 📝 = diketik manual, 📄 = hasil upload dokumen, thumbnail = gambar. Judul kosong otomatis pakai nama file.

## `.htaccess`: copy lokal disamakan dengan live + di-gitignore (2026-09-02)

Copy `.htaccess` di `D:\Juan\wonderland` ternyata masih versi lama yang isinya blok Passenger `compass` (`PassengerAppRoot ".../compass"`, `PassengerBaseURI "/compass"`) — persis blok yang bikin 404 di bagian **2** di atas dan sudah dibetulin di server live 2026-09-01. Kalau file lokal ini sampai kedorong ke server lewat Fileman API, routing `/wonderland` rusak lagi.

**Fix:** versi live ditarik turun (`GET /execute/Fileman/get_file_content?dir=public_html/wonderland&file=.htaccess`) lalu dipakai nimpa file lokal — sekarang lokal byte-identical sama live. Isi live cuma blok `wonderland` + `SetEnv BASE_PATH /wonderland`; `COMPASS_SECRET` dan `APIFY_API_TOKEN` yang nangkring di file lokal lama memang sudah tidak ada di live.

**Sekalian di-gitignore.** `.htaccess` itu tempat `SetEnv` nyimpen nilai rahasia plaintext dan isinya beda per environment, jadi sekarang di-ignore di dua tempat: `D:\Juan\wonderland\.gitignore` (`.htaccess`) dan repo ini (`app/.htaccess`). File ini belum pernah ke-commit (`git log --all -- '*.htaccess'` kosong, dan di file yang ke-track cuma *nama* variabelnya yang muncul), jadi tidak ada kredensial yang perlu di-rotate — ignore-nya murni pencegahan.
