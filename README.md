# School Unity

**One platform to run every school — together.**

School Unity is a multi-tenant SaaS school management system. Any number of schools sign up, each getting an isolated workspace to manage students, teachers, classes, attendance, exams, fees and communication.

## Run it on your computer

1. Install **Node.js 22.13 or newer** (the LTS version from https://nodejs.org).
2. Unzip the project folder.
3. Start it:
   - **Windows:** double-click `start.bat`
   - **macOS / Linux:** open a terminal in the folder and run `./start.sh`
4. Your browser opens http://localhost:3000. Stop the server with Ctrl+C (or close the window).

The first run installs dependencies and loads demo data. Data is kept in `data/school-unity.db`, so it's still there next time.

Manual alternative:

```bash
npm install
npm run seed      # demo data (use `npm run seed -- --reset` to start over)
npm start         # http://localhost:3000  (PORT=4000 npm start for another port)
```

No database server is needed (uses Node's built-in SQLite).

| Role | Email | Password |
|---|---|---|
| Platform owner (SaaS operator) | owner@schoolunity.app | owner12345 |
| School admin | admin@greenfield.edu (or admin@riverside.edu) | admin12345 |
| Teacher | teacher@greenfield.edu | teacher12345 |
| Student | student@greenfield.edu | student12345 |

## Features

- **Self-service school signup** with plans (Starter / Growth / Enterprise) and enforced student & teacher limits; paid plans are billed monthly in XAF through Notch Pay
- **Platform console** (super admin): all schools, MRR, change plan, suspend/reactivate, record offline plan payments, reset admin password, delete tenant, edit plans
- **Students**: admission, guardian & medical info, search/filter, pagination, CSV export, CSV import, portal logins, promotion/graduation
- **Teachers**: staff records, logins, class-teacher and subject assignments
- **Classes & subjects**: sections, capacity, subject teachers per class
- **Attendance**: daily class register (present/absent/late/excused), dashboard trend, date-range reports
- **Exams & results**: mark entry with live grading, class broadsheet with positions, printable report cards
- **Fees** in XAF by default (any currency per school): per-term fee structures (school-wide or per class), payments, printable receipts, balances, CSV export
- **Online payments with Notch Pay**: students/parents pay fees by MTN Mobile Money, Orange Money or card; payments are confirmed with Notch Pay's API and credited automatically
- **Announcements** (targeted to everyone / teachers / students) and **school calendar**
- **Student portal**: own profile, attendance, results/report cards and fee statement
- **Dashboards** per role, activity log, school settings (academic year/term, currency), multiple admins

## Security & multi-tenancy

- Every tenant table carries `school_id`; every school query filters on the signed-in user's school (covered by tests that attempt cross-tenant reads and deletes)
- Role-based access: `superadmin`, `admin`, `teacher` (only their classes/subjects), `student` (only their own record)
- bcrypt password hashing, CSRF tokens on all forms, session regeneration on login, login throttling, strict CSP and security headers, CSV formula-injection guard

## Project layout

```
server.js              app setup & route mounting
seed.js                demo data
src/db.js              schema (SQLite) + query helpers
src/middleware.js      auth, tenant loading, CSRF, role guards
src/access.js          teacher/admin scoping inside a school
src/routes/            public, platform, core, people, academics, finance, portal, pay
src/notchpay.js        Notch Pay API client
src/online-payments.js online fee & plan payments (checkout, verification, crediting)
views/                 EJS templates     public/  CSS + JS
test/                  end-to-end tests (npm test)
dev/fake-notchpay.js   stand-in Notch Pay API for tests and local demos
render.yaml            Render deployment blueprint
```

## Online payments (Notch Pay)

Set `NOTCHPAY_PUBLIC_KEY` to your Notch Pay public key (sandbox key for testing) to switch on online fee payments
and paid plan billing. Without it, students see "pay at the school office", and locally (not in production) plan
changes apply instantly as a demo.

To try the full payment flow locally without a Notch Pay account, run the stand-in API in one terminal:

```bash
node dev/fake-notchpay.js 4100
```

and start the app against it in another:

```bash
NOTCHPAY_PUBLIC_KEY=pk_test_fake NOTCHPAY_API_BASE=http://localhost:4100 npm start
```

## Going to production

See **[DEPLOY.md](DEPLOY.md)** for the step-by-step Render + Notch Pay setup. In short:

- Set `NODE_ENV=production`, a strong `SESSION_SECRET`, and `OWNER_EMAIL` / `OWNER_PASSWORD` for the first platform owner login; run behind HTTPS
- `DB_FILE` sets the database path (keep it on a persistent disk and back it up). For large deployments, port `src/db.js` to PostgreSQL
- Set `NOTCHPAY_PUBLIC_KEY`, and point the Notch Pay webhook at `https://<your-site>/webhooks/notchpay`
