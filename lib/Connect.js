'use strict';
// Connect.js — Nulls Connect (connect.nulls.gg) HTTP client used to bind game
// accounts headlessly. Verified against the nulls-connect-explorer proxy:
//   GET /auth/login.v2?email=<email>&game=laser&locale=ru
//     -> {pin_required:true,...} (PIN arrives by e-mail; can_register:true = new identity)
//   GET /auth/login.v2?email=<email>&game=laser&locale=ru&pin=<code>
//     -> {token:"..."} — bearer for every authenticated call, also registers new identities
//   GET /games/bind?bind_token=<jwt>&game=laser   (Authorization: Bearer <token>)
//     -> links the game account; bind_token is the JWT issued by the game server
//        in LoginOk (see Messaging/Messages/Server/LoginOkMessage.js extractBindToken)
//   GET /games/links?game=laser       -> linked accounts (player_info{tag,name,score})
//   GET /games/token?player_id=...    -> per-player game token (the login token)
// made by GLM-5.3 Flash
const fs = require('fs');
const path = require('path');

const BASE = (process.env.NC_API_UPSTREAM || 'https://connect.nulls.gg/api').replace(/\/+$/, '');
const PROFILES_BASE = (process.env.NC_PROFILES_UPSTREAM || 'https://profiles.dnull.xyz').replace(/\/+$/, '');
const DEFAULT_IMAGE_REF = '83a9523b-d954-4311-a62e-3ca8971403e1';   // default avatar uuid (as used by the explorer)
const STORE = path.join(__dirname, '..', '.runtime', 'connect.json');
const GAME = 'laser';
const UA = 'nulls-headless-client/0.2.6';

async function call(upstreamPath, params = {}, {method = 'GET', token = null, body, base = BASE} = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) qs.set(k, String(v));
  const headers = {accept: 'application/json', 'user-agent': UA};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + upstreamPath + (qs.size ? '?' + qs.toString() : ''), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const text = await res.text();
  let data = null;
  try {data = text ? JSON.parse(text) : null;} catch {data = text;}
  return {status: res.status, data};
}

function loadState() {try {return JSON.parse(fs.readFileSync(STORE, 'utf8'));} catch {return null;}}

function saveState(state) {
  fs.mkdirSync(path.dirname(STORE), {recursive: true});
  fs.writeFileSync(STORE, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
}

// step 1: request the PIN by e-mail. can_register=true makes the server create the
// identity when the e-mail has no account yet (otherwise it only mails a PIN for
// existing accounts, and replies "there's no account associated with your email"
// instead). Confirm the pin by calling confirmPin.
async function requestPin(email, {game = GAME, locale = 'ru', canRegister = true} = {}) {
  const params = {email, game, locale};
  if (canRegister) params.can_register = 'true';
  return call('/auth/login.v2', params);
}

// step 2: confirm the PIN -> stores the bearer locally and returns {token}
async function confirmPin(email, pin, {game = GAME, locale = 'ru'} = {}) {
  const r = await call('/auth/login.v2', {email, game, locale, pin});
  const token = r.data && typeof r.data === 'object' && r.data.token ? String(r.data.token) : null;
  if (token) saveState({email, token, at: Date.now(), game});
  return r;
}

// bearer from --connect-token or from .runtime/connect.json (connect-login)
function tokenOf(explicit) {
  if (explicit) return explicit;
  const state = loadState();
  return state && state.token ? state.token : null;
}

async function links(token, game = GAME) {return call('/games/links', {game}, {token});}

async function gameToken(token, playerId, game = GAME) {return call('/games/token', {player_id: playerId, game}, {token});}

// link a game account using the LoginOk bind-token JWT (query-string form like the
// explorer proxy; a few builds answer only to a JSON POST body — retry on 404/405)
async function bind(token, bindToken, game = GAME) {
  let r = await call('/games/bind', {bind_token: bindToken, game}, {token});
  if (r.status === 404 || r.status === 405) {
    r = await call('/games/bind', {}, {method: 'POST', token, body: {bind_token: bindToken, game}});
  }
  return r;
}

// public profile lookup on profiles.dnull.xyz (no auth): {handle, image_ref, ...}
async function profile(key, {game = 'laser', lookupType = 'GameAccountId'} = {}) {
  return call(`/${encodeURIComponent(game)}/${encodeURIComponent(key)}`, {lookup_type: lookupType}, {base: PROFILES_BASE});
}

// set the profile username (handle) and/or avatar — authenticates with the per-player
// game token minted from connect /games/token (account/connect bearers are rejected).
// profile: laser = the bound editable profile of that player.
async function updateProfile(gameToken, handle, imageRef = DEFAULT_IMAGE_REF, blockFriends = null) {
  const params = {handle, image_ref: imageRef};
  if (blockFriends !== null) params.block_friends = String(blockFriends);
  return call('/update', params, {method: 'POST', token: gameToken, body: {}, base: PROFILES_BASE});
}

module.exports = {requestPin, confirmPin, tokenOf, links, gameToken, bind, profile, updateProfile, loadState, BASE, PROFILES_BASE, DEFAULT_IMAGE_REF, GAME};
