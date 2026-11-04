#!/usr/bin/env bash
# =============================================================================
#  Khiana launcher (macOS / Linux)
#
#    ./khiana.sh              interactive menu
#    ./khiana.sh play         or any command directly
#
#  Services run as background jobs of THIS shell and are torn down together on
#  Ctrl-C. That matters more than it sounds: three orphaned node processes
#  holding ports is the most common way a second demo attempt fails.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$ROOT/server"
CLIENT="$ROOT/client"
SPECTATOR="$ROOT/spectator"
CONTRACTS="$ROOT/contracts"
PORTS=(8787 5173 5174)

bold=$'\033[1m'; dim=$'\033[2m'; amber=$'\033[33m'; red=$'\033[31m'; off=$'\033[0m'
say()  { printf '  %s\n' "$*"; }
head_() { printf '\n%s%s%s\n' "$bold" "$*" "$off"; }
die()  { printf '\n  %s%s%s\n\n' "$red" "$*" "$off"; exit 1; }

# ── prerequisites ────────────────────────────────────────────────────────────
check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get Node 18+: https://nodejs.org"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node $major is too old. Khiana needs 18 or newer."
}

# Only install when node_modules is genuinely missing — running npm install on
# every launch turns a two-second start into a two-minute one.
install_if_needed() {
  local dir="$1" name="$2"
  [ -d "$dir/node_modules" ] && return 0
  say "installing $name dependencies…"
  (cd "$dir" && npm install --no-audit --no-fund) || die "npm install failed in $name"
}

ensure_deps() {
  install_if_needed "$SERVER" server
  install_if_needed "$CLIENT" client
  install_if_needed "$SPECTATOR" spectator
}

ensure_env() {
  [ -f "$ROOT/.env" ] && return 0
  say "no .env found — creating one from .env.example"
  cp "$ROOT/.env.example" "$ROOT/.env"
  head_ "Created .env"
  say "The game runs fully in MOCK_CHAIN mode with no keys at all."
  say "Add GROQ_API_KEY for real agents, AGENT_MNEMONIC for on-chain settlement."
  echo
}

# ── process control ──────────────────────────────────────────────────────────
free_ports() {
  for p in "${PORTS[@]}"; do
    # lsof is on macOS by default; fall back to fuser on Linux.
    if command -v lsof >/dev/null 2>&1; then
      local pids; pids="$(lsof -ti tcp:"$p" 2>/dev/null || true)"
      [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    elif command -v fuser >/dev/null 2>&1; then
      fuser -k "$p"/tcp 2>/dev/null || true
    fi
  done
}

PIDS=()
cleanup() {
  echo
  say "shutting down…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  free_ports
  exit 0
}

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  else say "open $1"; fi
}

spawn() {  # spawn <dir> <label> <cmd...>
  local dir="$1" label="$2"; shift 2
  ( cd "$dir" && "$@" 2>&1 | sed "s/^/[$label] /" ) &
  PIDS+=($!)
}

# ── commands ─────────────────────────────────────────────────────────────────
cmd_setup() {
  ensure_env
  install_if_needed "$SERVER" server
  install_if_needed "$CLIENT" client
  install_if_needed "$SPECTATOR" spectator
  install_if_needed "$CONTRACTS" contracts
  head_ "Setup complete"; say "Run: ./khiana.sh play"; echo
}

_serve() {  # _serve [extra env assignments]
  ensure_env; ensure_deps; free_ports
  trap cleanup INT TERM

  head_ "starting Khiana"
  spawn "$SERVER"    server    env "$@" npm start
  spawn "$CLIENT"    client    npm run dev
  spawn "$SPECTATOR" spectator npm run dev

  # Vite needs a moment to bind; opening sooner just shows a refused connection.
  sleep 6
  open_url http://localhost:5173
  open_url http://localhost:5174

  head_ "running"
  say "landing    ${amber}http://localhost:5173${off}   lobbies, how to play"
  say "game       http://localhost:5173/play.html"
  say "spectator  ${amber}http://localhost:5174${off}"
  say "server     http://localhost:8787"
  echo
  say "${dim}Open a table on the landing page, or start the main one:${off}"
  say "  curl -X POST http://localhost:8787/game/start"
  echo
  say "${dim}Ctrl-C stops everything.${off}"
  wait
}

cmd_play()   { _serve; }
cmd_record() {
  head_ "recording this run"
  say "Saved to server/recordings/ when the game ENDS. Replay: ./khiana.sh playback"
  _serve RECORD=true
}

cmd_test() {
  ensure_deps
  install_if_needed "$CONTRACTS" contracts
  local rc=0
  head_ "game core";   (cd "$SERVER" && node game.test.mjs) || rc=1
  head_ "integration"; (cd "$SERVER" && node integration.test.mjs) || rc=1
  head_ "contracts";   (cd "$CONTRACTS" && npx hardhat test) || rc=1
  echo
  [ $rc -eq 0 ] && say "${amber}all suites passed${off}" || say "${red}some suites failed${off}"
  echo
  return $rc
}

cmd_headless() { ensure_env; ensure_deps; (cd "$SERVER" && npm run headless); }

cmd_playback() {
  ensure_deps; free_ports
  [ -d "$SERVER/recordings" ] || die "No recordings yet. Make one with: ./khiana.sh record"
  trap cleanup INT TERM
  spawn "$SERVER"    playback  npm run playback
  spawn "$SPECTATOR" spectator npm run dev
  sleep 6
  open_url http://localhost:5174
  head_ "replaying"
  say "The spectator client cannot tell this from a live game."
  say "${dim}Ctrl-C stops everything.${off}"
  wait
}

cmd_wallets() { ensure_env; ensure_deps; (cd "$SERVER" && npm run wallets); }

cmd_deploy() {
  ensure_env; install_if_needed "$CONTRACTS" contracts
  (cd "$CONTRACTS" && npm run deploy)
  head_ "next"; say "Paste the addresses into .env, then: ./khiana.sh verify"; echo
}

cmd_verify() {
  ensure_env; ensure_deps
  head_ "settlement"; (cd "$SERVER" && npm run phase1)
  head_ "x402";       (cd "$SERVER" && npm run x402)
}

cmd_stop() { free_ports; say "stopped anything listening on ${PORTS[*]}"; }

# ── entry ────────────────────────────────────────────────────────────────────
check_node

dispatch() {
  case "${1:-}" in
    play)     cmd_play ;;
    record)   cmd_record ;;
    test)     cmd_test ;;
    headless) cmd_headless ;;
    playback) cmd_playback ;;
    setup)    cmd_setup ;;
    wallets)  cmd_wallets ;;
    deploy)   cmd_deploy ;;
    verify)   cmd_verify ;;
    stop)     cmd_stop ;;
    *) die "Unknown command '${1:-}'. Try: play | test | headless | playback | record | setup | wallets | deploy | verify | stop" ;;
  esac
}

if [ $# -gt 0 ]; then
  dispatch "$1"
  exit $?
fi

while true; do
  clear
  cat <<BANNER

  ${bold}KHIANA${off}
  ${dim}A 3D fog-of-war maze where your AI advisor may have been paid to lie.${off}
  ---------------------------------------------------------------------

   1  Play            start everything and open both screens
   2  Test            run every test suite
   3  Headless        watch a full game as text, no browser
   4  Playback        replay the last recorded run (demo parachute)
   5  Record          play, and save the run for playback

   6  Setup           install all dependencies
   7  Wallets         show addresses and balances
   8  Deploy          deploy contracts to Monad testnet
   9  Verify chain    prove settlement + x402 on testnet

   0  Stop            kill anything still listening on our ports
   q  Quit

BANNER
  read -rp "  > " choice
  case "$choice" in
    1) dispatch play ;;      2) dispatch test ;;
    3) dispatch headless ;;  4) dispatch playback ;;
    5) dispatch record ;;    6) dispatch setup ;;
    7) dispatch wallets ;;   8) dispatch deploy ;;
    9) dispatch verify ;;    0) dispatch stop ;;
    q|Q) exit 0 ;;
    *) say "unknown option" ;;
  esac
  echo; read -rp "  press enter to return to the menu… " _
done
