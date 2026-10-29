#!/bin/zsh

# Publikuje 1702 gotowe pliki bez ponownej kompresji i bez modyfikowania źródeł.
# Użycie:
#   ./scripts/publish-media.sh
#   ./scripts/publish-media.sh "/inna/sciezka/media_skompresowane"

set -euo pipefail

readonly EXPECTED_FILES=1702
readonly OWNER="ad2chacik"
readonly APP_REPO="${OWNER}/Prawo-jazdy"
readonly MEDIA_REPO="${OWNER}/Prawo-jazdy-media"
readonly DEFAULT_SOURCE="$HOME/Documents/prawo jazdy apka/media_skompresowane"
readonly SOURCE_DIR="${1:-$DEFAULT_SOURCE}"
readonly PAGES_SAFETY_LIMIT=900000000
readonly GIT_FILE_LIMIT=$((100 * 1024 * 1024))
readonly GIT_WARNING_SIZE=$((50 * 1024 * 1024))

say() { printf '\n%s\n' "$1"; }
fail() { printf '\nBŁĄD: %s\n' "$1" >&2; exit 1; }

for command_name in git gh python3 curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Brak programu: $command_name"
done

[[ -d "$SOURCE_DIR" ]] || fail "Nie znaleziono folderu: $SOURCE_DIR"
gh auth status >/dev/null 2>&1 || fail "Najpierw zaloguj GitHub CLI poleceniem: gh auth login"
[[ "$(gh api user --jq .login)" == "$OWNER" ]] || fail "Zalogowane konto GitHub nie jest kontem $OWNER."

WORK_DIR="$(mktemp -d "${TMPDIR%/}/prawko-media.XXXXXX")"
cleanup() {
  if [[ -n "${WORK_DIR:-}" && "$WORK_DIR" == "${TMPDIR%/}"/prawko-media.* && -d "$WORK_DIR" ]]; then
    chmod -R u+w "$WORK_DIR" 2>/dev/null || true
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT INT TERM

APP_DIR="$WORK_DIR/app"
MEDIA_DIR="$WORK_DIR/media-repo"
PLAN_DIR="$WORK_DIR/plan"
mkdir -p "$PLAN_DIR"

say "1/7 Pobieram bezpieczną kopię roboczą aplikacji…"
git clone --quiet "https://github.com/${APP_REPO}.git" "$APP_DIR"
[[ -f "$APP_DIR/app.js" ]] || fail "Repozytorium aplikacji nie zawiera app.js."
grep -q "PUBLISHED_MEDIA_MAP_PATH" "$APP_DIR/app.js" || fail "Najpierw połącz zmianę aplikacji obsługującą data/media-map.json."

say "2/7 Sprawdzam 1702 pliki, nazwy, Excel, rozmiary i sumy kontrolne…"
python3 - "$SOURCE_DIR" "$APP_DIR" "$PLAN_DIR" "$EXPECTED_FILES" "$PAGES_SAFETY_LIMIT" "$GIT_FILE_LIMIT" "$GIT_WARNING_SIZE" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

source = Path(sys.argv[1]).resolve()
app = Path(sys.argv[2]).resolve()
plan_dir = Path(sys.argv[3]).resolve()
expected_count = int(sys.argv[4])
pages_limit = int(sys.argv[5])
git_limit = int(sys.argv[6])
warning_size = int(sys.argv[7])
allowed = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.mp4', '.m4v', '.mov', '.webm'}

def normalized_name(value: str) -> str:
    return unicodedata.normalize('NFC', Path(str(value).replace('\\', '/')).name.strip()).lower()

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def cell_value(cell, shared):
    cell_type = cell.attrib.get('t')
    if cell_type == 'inlineStr':
        return ''.join(node.text or '' for node in cell.iter() if node.tag.endswith('}t'))
    value = next((node.text or '' for node in cell if node.tag.endswith('}v')), '')
    if cell_type == 's' and value:
        try:
            return shared[int(value)]
        except (ValueError, IndexError):
            return ''
    return value

def xlsx_media_names(path: Path):
    if not path.is_file():
        raise SystemExit(f'Brak bazy pytań: {path}')
    result = set()
    with zipfile.ZipFile(path) as book:
        shared = []
        if 'xl/sharedStrings.xml' in book.namelist():
            root = ET.fromstring(book.read('xl/sharedStrings.xml'))
            for item in root:
                shared.append(''.join(node.text or '' for node in item.iter() if node.tag.endswith('}t')))
        sheets = sorted(name for name in book.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name))
        for sheet in sheets:
            root = ET.fromstring(book.read(sheet))
            media_column = None
            category_column = None
            header_row = None
            for row in (node for node in root.iter() if node.tag.endswith('}row')):
                values = {}
                for cell in (node for node in row if node.tag.endswith('}c')):
                    ref = cell.attrib.get('r', '')
                    column = re.match(r'[A-Z]+', ref)
                    if column:
                        values[column.group()] = cell_value(cell, shared).strip()
                if media_column is None:
                    for column, value in values.items():
                        header = unicodedata.normalize('NFC', value).strip().casefold()
                        if header == 'media':
                            media_column = column
                            header_row = int(row.attrib.get('r', '0') or 0)
                        elif header in {'kategorie', 'kategoria'}:
                            category_column = column
                    continue
                if int(row.attrib.get('r', '0') or 0) <= (header_row or 0):
                    continue
                categories = [item.strip().upper() for item in re.split(r'[;,]', values.get(category_column, '')) if item.strip()]
                if categories and 'B' not in categories:
                    continue
                value = values.get(media_column, '').strip()
                if value and value.casefold() != 'nan':
                    name = normalized_name(value)
                    if name.endswith('.wmv'):
                        name = name[:-4] + '.mp4'
                    result.add(name)
    return result

files = {}
unsupported = []
for path in source.rglob('*'):
    if not path.is_file() or path.name.startswith('.'):
        continue
    if path.suffix.lower() not in allowed:
        unsupported.append(str(path.relative_to(source)))
        continue
    name = normalized_name(path.name)
    if name in files:
        raise SystemExit(f'Kolizja nazw po normalizacji: {files[name]} oraz {path}')
    files[name] = path

if unsupported:
    raise SystemExit('Folder zawiera nieobsługiwane pliki: ' + ', '.join(unsupported[:10]))
if len(files) != expected_count:
    raise SystemExit(f'Znaleziono {len(files)} multimediów zamiast {expected_count}. Niczego nie wysłano.')

too_large = [(name, path.stat().st_size) for name, path in files.items() if path.stat().st_size > git_limit]
if too_large:
    details = ', '.join(f'{name} ({size / 1024 / 1024:.1f} MiB)' for name, size in too_large[:10])
    raise SystemExit(f'Pliki przekraczają twardy limit GitHuba 100 MiB: {details}')

xlsx_names = xlsx_media_names(app / 'data' / 'questions.xlsx')
source_names = set(files)
missing = sorted(xlsx_names - source_names)
extra = sorted(source_names - xlsx_names)

app_overhead = sum(
    path.stat().st_size for path in app.rglob('*')
    if path.is_file() and '.git' not in path.parts and 'media' not in path.relative_to(app).parts[:1]
)
# Keep the split stable across future edits to documentation or this script.
# This is the measured non-media size used for the first successful split.
split_app_overhead = 1_504_541
secondary_overhead = 64 * 1024
bins = {
    'primary': {'bytes': split_app_overhead, 'names': []},
    'secondary': {'bytes': secondary_overhead, 'names': []},
}
records = []
large_warnings = []
for name, path in sorted(files.items(), key=lambda item: (-item[1].stat().st_size, item[0])):
    size = path.stat().st_size
    target = min(bins, key=lambda key: (bins[key]['bytes'], key))
    bins[target]['names'].append(name)
    bins[target]['bytes'] += size
    record = {'name': name, 'source': str(path), 'size': size, 'location': target, 'sha256': sha256(path)}
    records.append(record)
    if size > warning_size:
        large_warnings.append({'name': name, 'size': size})

media_bytes = {
    key: sum(files[name].stat().st_size for name in value['names'])
    for key, value in bins.items()
}
site_bytes = {
    'primary': media_bytes['primary'] + app_overhead,
    'secondary': media_bytes['secondary'] + secondary_overhead,
}
if max(site_bytes.values()) > pages_limit:
    raise SystemExit(
        'Podział nie mieści się w przyjętym limicie bezpieczeństwa 900 MB: ' +
        ', '.join(f"{key}={value}" for key, value in site_bytes.items())
    )

plan = {
    'version': 1,
    'totalFiles': len(records),
    'totalBytes': sum(record['size'] for record in records),
    'appOverheadBytes': app_overhead,
    'locations': {
        key: {'files': len(value['names']), 'mediaBytes': media_bytes[key], 'siteBytes': site_bytes[key]}
        for key, value in bins.items()
    },
    'largeFileWarnings': large_warnings,
    'excelCheck': {
        'referencedFiles': len(xlsx_names),
        'missingFromSource': missing,
        'notReferencedByCategoryB': extra,
    },
    'records': sorted(records, key=lambda record: record['name']),
}
free_bytes = shutil.disk_usage(plan_dir).free
required_bytes = plan['totalBytes'] * 3 + 500_000_000
if free_bytes < required_bytes:
    raise SystemExit(
        f'Za mało wolnego miejsca na bezpieczne kopie robocze. Dostępne: {free_bytes / 1_000_000:.1f} MB; '
        f'wymagane około: {required_bytes / 1_000_000:.1f} MB.'
    )
(plan_dir / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f"Kompletność: {len(records)}/{expected_count}")
print(f"Razem: {plan['totalBytes'] / 1_000_000:.1f} MB")
for key, value in plan['locations'].items():
    print(f"{key}: {value['files']} plików, multimedia {value['mediaBytes'] / 1_000_000:.1f} MB, cała strona około {value['siteBytes'] / 1_000_000:.1f} MB")
if large_warnings:
    print(f"UWAGA: {len(large_warnings)} plików przekracza 50 MiB, ale żaden nie przekracza 100 MiB.")
if missing or extra:
    print(
        f"UWAGA — Excel kategorii B: {len(xlsx_names)} nazw; w folderze brakuje {len(missing)}, "
        f"a {len(extra)} pliki z folderu nie są wskazane przez pytania kategorii B."
    )
    if missing:
        print('Pierwsze brakujące nazwy: ' + ', '.join(missing[:12]))
    if extra:
        print('Niewskazane nazwy: ' + ', '.join(extra[:12]))
PY

printf '\nSkrypt utworzy lub zaktualizuje publiczne repozytorium %s, a następnie wyśle multimedia do obu repozytoriów.\n' "$MEDIA_REPO"
printf 'Wpisz PUBLIKUJ, aby kontynuować: '
read -r CONFIRMATION
[[ "$CONFIRMATION" == "PUBLIKUJ" ]] || { printf 'Anulowano. Niczego nie wysłano.\n'; exit 0; }

say "3/7 Przygotowuję kopie robocze obu repozytoriów…"
if gh repo view "$MEDIA_REPO" --json nameWithOwner >/dev/null 2>&1; then
  [[ "$(gh repo view "$MEDIA_REPO" --json visibility --jq .visibility)" == "PUBLIC" ]] || fail "Repozytorium $MEDIA_REPO istnieje, ale nie jest publiczne."
else
  gh repo create "$MEDIA_REPO" --public --description "Multimedia dla aplikacji Prawo-jazdy" --disable-issues --disable-wiki
fi

git clone --quiet --filter=blob:none --sparse "https://github.com/${MEDIA_REPO}.git" "$MEDIA_DIR"
if [[ ! -d "$MEDIA_DIR/.git" ]]; then
  mkdir -p "$MEDIA_DIR"
  git -C "$MEDIA_DIR" init -q -b main
  git -C "$MEDIA_DIR" remote add origin "https://github.com/${MEDIA_REPO}.git"
fi

if [[ -n "$(git -C "$MEDIA_DIR" ls-files 2>/dev/null)" && ! -f "$MEDIA_DIR/.prawko-media-repo" ]]; then
  fail "Repozytorium $MEDIA_REPO nie jest puste i nie ma znacznika bezpiecznego zarządzania. Niczego nie nadpisano."
fi

python3 - "$APP_DIR" "$MEDIA_DIR" "$PLAN_DIR/plan.json" "$OWNER" <<'PY'
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

app = Path(sys.argv[1]).resolve()
media_repo = Path(sys.argv[2]).resolve()
plan_path = Path(sys.argv[3]).resolve()
owner = sys.argv[4]
plan = json.loads(plan_path.read_text(encoding='utf-8'))

def safe_reset_media(root: Path):
    target = root / 'media'
    if target.exists():
        if target.is_symlink() or target.resolve().parent != root.resolve():
            raise SystemExit(f'Niebezpieczna ścieżka katalogu media: {target}')
        shutil.rmtree(target)
    target.mkdir()
    return target

def sha256(path: Path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

app_media = safe_reset_media(app)
secondary_media = safe_reset_media(media_repo)
manifests = {'primary': [], 'secondary': []}
files_map = {}

for record in plan['records']:
    source = Path(record['source'])
    destination_dir = app_media if record['location'] == 'primary' else secondary_media
    destination = destination_dir / record['name']
    shutil.copy2(source, destination)
    if destination.stat().st_size != record['size'] or sha256(destination) != record['sha256']:
        raise SystemExit(f'Kopia nie przeszła kontroli sumy: {record["name"]}')
    manifests[record['location']].append({key: record[key] for key in ('name', 'size', 'sha256')})
    files_map[record['name']] = record['location']

media_map = {
    'version': 1,
    'totalFiles': plan['totalFiles'],
    'totalBytes': plan['totalBytes'],
    'bases': {
        'primary': './media/',
        'secondary': f'https://{owner}.github.io/Prawo-jazdy-media/media/',
    },
    'files': files_map,
}
(app / 'data' / 'media-map.json').write_text(json.dumps(media_map, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

for location, root in [('primary', app), ('secondary', media_repo)]:
    manifest = {
        'version': 1,
        'location': location,
        'files': len(manifests[location]),
        'bytes': sum(item['size'] for item in manifests[location]),
        'items': manifests[location],
    }
    (root / 'media-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

(media_repo / '.prawko-media-repo').write_text('managed-by=Prawo-jazdy/scripts/publish-media.sh\n', encoding='utf-8')
(media_repo / '.nojekyll').write_text('', encoding='utf-8')
(media_repo / 'README.md').write_text(
    '# Prawo-jazdy-media\n\nRepozytorium multimediów dla aplikacji '
    f'[{owner}/Prawo-jazdy](https://github.com/{owner}/Prawo-jazdy). '
    'Pliki i manifest są zarządzane przez skrypt publikacyjny z głównego repozytorium.\n',
    encoding='utf-8',
)
(media_repo / 'index.html').write_text(
    '<!doctype html><meta charset="utf-8"><title>Prawo-jazdy-media</title>'
    '<p>Repozytorium multimediów aplikacji Prawo-jazdy.</p>\n',
    encoding='utf-8',
)

for location, root in [('primary', app), ('secondary', media_repo)]:
    copied = list((root / 'media').iterdir())
    expected = plan['locations'][location]
    if len(copied) != expected['files'] or sum(path.stat().st_size for path in copied) != expected['mediaBytes']:
        raise SystemExit(f'Kontrola końcowa kopii nie powiodła się dla {location}.')
print('Wszystkie kopie robocze mają identyczne rozmiary i sumy SHA-256 jak źródła.')
PY

GITHUB_LOGIN="$(gh api user --jq .login)"
GITHUB_ID="$(gh api user --jq .id)"
for repo_dir in "$APP_DIR" "$MEDIA_DIR"; do
  git -C "$repo_dir" config user.name "$GITHUB_LOGIN"
  git -C "$repo_dir" config user.email "${GITHUB_ID}+${GITHUB_LOGIN}@users.noreply.github.com"
  git -C "$repo_dir" config core.compression 0
done

git -C "$MEDIA_DIR" add --sparse .prawko-media-repo .nojekyll README.md index.html media media-manifest.json
if ! git -C "$MEDIA_DIR" diff --cached --quiet; then
  git -C "$MEDIA_DIR" commit -q -m "Publish second half of question media"
fi
MEDIA_SHA="$(git -C "$MEDIA_DIR" rev-parse HEAD)"

git -C "$APP_DIR" add media data/media-map.json media-manifest.json
if ! git -C "$APP_DIR" diff --cached --quiet; then
  git -C "$APP_DIR" commit -q -m "Publish mapped question media"
fi
APP_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"

configure_pages() {
  local repo="$1"
  local create_payload='{"source":{"branch":"main","path":"/"}}'
  local update_payload='{"build_type":"legacy","source":{"branch":"main","path":"/"}}'
  local current method payload
  current="$(gh api "repos/$repo/pages" 2>/dev/null || true)"
  if [[ -n "$current" ]] && printf '%s' "$current" | python3 -c 'import json,sys; p=json.load(sys.stdin); raise SystemExit(0 if p.get("build_type")=="legacy" and p.get("source")=={"branch":"main","path":"/"} else 1)'; then
    return 0
  elif [[ -n "$current" ]]; then
    method="PUT"
    payload="$update_payload"
  else
    method="POST"
    payload="$create_payload"
  fi

  # A freshly pushed default branch can need a few seconds before the Pages
  # endpoint accepts it. Retry only this idempotent configuration step.
  for attempt in {1..18}; do
    if printf '%s' "$payload" | gh api \
      --method "$method" \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "repos/$repo/pages" --input - >/dev/null 2>&1; then
      return 0
    fi
    printf 'GitHub jeszcze przygotowuje Pages dla %s; ponawiam (%s/18)…\n' "$repo" "$attempt"
    sleep 5
  done
  fail "Nie udało się włączyć GitHub Pages dla $repo po 18 próbach. Wysłane pliki pozostają bezpiecznie w repozytorium."
}

wait_for_pages() {
  local repo="$1"
  local expected_sha="$2"
  local label="$3"
  local build page_status commit
  for attempt in {1..75}; do
    build="$(gh api "repos/$repo/pages/builds/latest" 2>/dev/null || true)"
    if [[ -n "$build" ]]; then
      page_status="$(printf '%s' "$build" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", ""))')"
      commit="$(printf '%s' "$build" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit", ""))')"
      if [[ "$commit" == "$expected_sha" && "$page_status" == "built" ]]; then
        printf '%s: wdrożone.\n' "$label"
        return 0
      fi
      if [[ "$commit" == "$expected_sha" && "$page_status" == "errored" ]]; then
        fail "Wdrożenie Pages zakończyło się błędem dla $repo. Sprawdź kartę Actions."
      fi
    fi
    sleep 10
  done
  fail "Pages nie potwierdziło wdrożenia $repo w wyznaczonym czasie. Commity są bezpiecznie wysłane; sprawdź kartę Actions."
}

remote_media_count() {
  gh api "repos/$1/git/trees/$2?recursive=1" --jq '[.tree[] | select(.type == "blob" and (.path | startswith("media/")))] | length'
}

PRIMARY_EXPECTED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["locations"]["primary"]["files"])' "$PLAN_DIR/plan.json")"
SECONDARY_EXPECTED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["locations"]["secondary"]["files"])' "$PLAN_DIR/plan.json")"

say "4/7 Wysyłam najpierw dodatkowe repozytorium…"
git -C "$MEDIA_DIR" push origin HEAD:main
configure_pages "$MEDIA_REPO"
wait_for_pages "$MEDIA_REPO" "$MEDIA_SHA" "Dodatkowa strona"
[[ "$(remote_media_count "$MEDIA_REPO" "$MEDIA_SHA")" == "$SECONDARY_EXPECTED" ]] || fail "Zdalne repozytorium dodatkowe ma nieprawidłową liczbę plików."

say "5/7 Wysyłam główne multimedia i mapę lokalizacji…"
git -C "$APP_DIR" push origin HEAD:main
configure_pages "$APP_REPO"
wait_for_pages "$APP_REPO" "$APP_SHA" "Główna aplikacja"
[[ "$(remote_media_count "$APP_REPO" "$APP_SHA")" == "$PRIMARY_EXPECTED" ]] || fail "Główne repozytorium ma nieprawidłową liczbę plików."

say "6/7 Sprawdzam publiczne adresy obu stron…"
PRIMARY_SAMPLE="$(python3 -c 'import json,sys,urllib.parse; p=json.load(open(sys.argv[1])); print(urllib.parse.quote(next(r["name"] for r in p["records"] if r["location"]=="primary")))' "$PLAN_DIR/plan.json")"
SECONDARY_SAMPLE="$(python3 -c 'import json,sys,urllib.parse; p=json.load(open(sys.argv[1])); print(urllib.parse.quote(next(r["name"] for r in p["records"] if r["location"]=="secondary")))' "$PLAN_DIR/plan.json")"
curl -fsSIL --retry 4 --retry-delay 5 "https://${OWNER}.github.io/Prawo-jazdy/data/media-map.json" >/dev/null
curl -fsSIL --retry 4 --retry-delay 5 "https://${OWNER}.github.io/Prawo-jazdy/media/${PRIMARY_SAMPLE}" >/dev/null
curl -fsSIL --retry 4 --retry-delay 5 "https://${OWNER}.github.io/Prawo-jazdy-media/media/${SECONDARY_SAMPLE}" >/dev/null

say "7/7 GOTOWE"
printf 'Opublikowano %s/%s plików bez ponownej kompresji.\n' "$EXPECTED_FILES" "$EXPECTED_FILES"
printf 'Główna aplikacja: https://%s.github.io/Prawo-jazdy/\n' "$OWNER"
printf 'Dodatkowe multimedia: https://%s.github.io/Prawo-jazdy-media/\n' "$OWNER"
printf 'Oryginalny folder pozostał nietknięty: %s\n' "$SOURCE_DIR"
