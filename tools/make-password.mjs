#!/usr/bin/env node
// Prints a scrypt hash for auth.passwordHash, so the plaintext never has to
// be written into the config file.
//
//   node tools/make-password.mjs 'the password'
import { hashPassword, generateToken } from '../src/auth.js';

const [, , password] = process.argv;
if (!password) {
  console.log('usage: node tools/make-password.mjs <password>');
  console.log('\na random token instead:\n  ' + generateToken());
  process.exit(1);
}
console.log(hashPassword(password));
