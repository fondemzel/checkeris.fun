// Пользователи кабинета и выданные токены.
//
//   node api/src/users.mjs --list
//   node api/src/users.mjs --add <логин> <пароль>
//   node api/src/users.mjs --password <логин> <новый пароль>
//   node api/src/users.mjs --remove <логин>          — вместе со всеми его токенами
//   node api/src/users.mjs --tokens                  — кто и когда входил
//   node api/src/users.mjs --revoke <логин>          — отозвать все токены пользователя
//
// Пароль в аргументах виден в истории команд — на своей машине это приемлемо,
// на сервере лучше запускать с ведущим пробелом или менять пароль потом.
import { pathToFileURL } from 'node:url';
import { openDb, migrate } from './db.mjs';
import { hashPassword, hasUsers } from './auth.mjs';

export function addUser(db, login, password) {
  const name = String(login ?? '').trim();
  if (!name) throw new Error('нужен логин');
  if (String(password ?? '').length < 8) throw new Error('пароль короче 8 символов');
  if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(name)) throw new Error(`пользователь «${name}» уже есть`);

  db.prepare('INSERT INTO users (login, password, created_at) VALUES (?, ?, ?)').run(
    name,
    hashPassword(password),
    new Date().toISOString(),
  );
  return name;
}

export function setPassword(db, login, password) {
  if (String(password ?? '').length < 8) throw new Error('пароль короче 8 символов');
  const changed = db
    .prepare('UPDATE users SET password = ? WHERE login = ?')
    .run(hashPassword(password), String(login ?? '').trim()).changes;
  if (!changed) throw new Error(`нет пользователя «${login}»`);
  // Смена пароля гасит выданные токены: иначе старое устройство осталось бы с доступом
  const user = db.prepare('SELECT id FROM users WHERE login = ?').get(String(login).trim());
  return db.prepare('DELETE FROM tokens WHERE user_id = ?').run(user.id).changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, ...rest] = process.argv.slice(2);
  const db = openDb();
  migrate(db);

  try {
    if (flag === '--add') {
      console.log(`добавлен: ${addUser(db, rest[0], rest[1])}`);
    } else if (flag === '--password') {
      console.log(`пароль изменён, отозвано токенов: ${setPassword(db, rest[0], rest[1])}`);
    } else if (flag === '--remove') {
      const n = db.prepare('DELETE FROM users WHERE login = ?').run(String(rest[0] ?? '').trim()).changes;
      console.log(n ? `удалён: ${rest[0]}` : `нет пользователя «${rest[0]}»`);
    } else if (flag === '--revoke') {
      const user = db.prepare('SELECT id FROM users WHERE login = ?').get(String(rest[0] ?? '').trim());
      if (!user) throw new Error(`нет пользователя «${rest[0]}»`);
      console.log(`отозвано токенов: ${db.prepare('DELETE FROM tokens WHERE user_id = ?').run(user.id).changes}`);
    } else if (flag === '--tokens') {
      const rows = db
        .prepare(
          `SELECT u.login, t.label, t.created_at, t.expires_at, t.used_at
             FROM tokens t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC`,
        )
        .all();
      if (!rows.length) console.log('токенов нет');
      for (const r of rows) {
        console.log(
          `  ${r.login.padEnd(12)} ${(r.label ?? '—').padEnd(10)} выдан ${r.created_at.slice(0, 16)}` +
            ` · до ${r.expires_at.slice(0, 10)} · последний вход ${r.used_at?.slice(0, 16) ?? 'не входили'}`,
        );
      }
    } else {
      const rows = db.prepare('SELECT login, created_at FROM users ORDER BY id').all();
      if (!hasUsers(db)) {
        console.log('пользователей нет — кабинет никого не пустит.');
        console.log('Заведите первого: node api/src/users.mjs --add <логин> <пароль>');
      } else {
        console.log('пользователи:');
        for (const r of rows) console.log(`  ${r.login.padEnd(14)} с ${r.created_at.slice(0, 10)}`);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  db.close();
}
