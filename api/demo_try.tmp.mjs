import { openDb, migrate } from './src/db.mjs';
import { enableDemo } from './src/demo.mjs';
import { ensureBudget } from './src/budgets.mjs';
const db = openDb(); migrate(db);
db.prepare("INSERT INTO users (login, password, created_at, name) VALUES ('t', '!', '2026', 'Т')").run();
const u = db.prepare("SELECT * FROM users WHERE login='t'").get(); ensureBudget(db, u.id);
try { enableDemo(db, db.prepare("SELECT * FROM users WHERE login='t'").get()); } catch (e) { console.log('ошибка', e.message); }
