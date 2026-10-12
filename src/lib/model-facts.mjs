/**
 * Факты моделей для выбора модели стадии (README, «Выбор модели стадии»): оценка
 * силы (`intelligence` Artificial Analysis) и признак «бесплатная» по id модели,
 * как её вызывает агент. Чистые функции над кэшем команды оценок
 * (scripts/model-scores.js, режим фактов) и каталогом kilo (lib/kilo-catalog.mjs):
 * сети и файлов здесь нет.
 *
 * Кэш — `{ catalog: {<id каталога>: <canonical_slug>}, benchmarks: {<slug>: {intelligence,
 * coding, agentic}}, models: {<id каталога>: {created, prompt, completion, alias_target}} }`
 * (каталог OpenRouter `/api/v1/models` и оценки `/api/v1/benchmarks`). Имён моделей,
 * производителей и порогов код не знает: всё — из данных каталога.
 *
 * Термины:
 *  - маршрут — первый сегмент id из трёх и больше сегментов (`kilo/qwen/x:free`);
 *  - производитель — сегмент перед именем модели; у id без `/` (модель CLI claude,
 *    `claude-opus-5`) его нет;
 *  - вариант — хвост `:…` имени;
 *  - дата — хвост `-YYYYMMDD` (у slug и id) или `-MMDD` (только у id: `-0813`);
 *  - ключ семейства — имя в нижнем регистре, разбитое по `-`, без даты и варианта, с
 *    подряд идущими короткими числами, слитыми в версию через точку (`4`, `5` → `4.5`);
 *  - токен версии — `^v?\d+(\.\d+)*$`;
 *  - дата версии записи — дата её `canonical_slug`, иначе дата `created`.
 *
 * Оценка (правила по порядку, раздел README «Разрешение оценки»):
 *  R1 прямая запись — первый из [id, id без маршрута], который есть в каталоге; у id
 *     без производителя — записи каталога (не `~`-псевдонимы) с последним сегментом,
 *     равным id, ровно одного производителя;
 *  R2 недатированный id — самая новая запись с тем же slug без даты: каталог держит
 *     старую версию под недатированным id (`deepseek/deepseek-v4-pro` → slug
 *     `-20260423`, а новее есть `-20260813`); датированный id держит свою версию;
 *  R3 id без записи — псевдоним каталога `~<производитель>/<имя>-latest` с
 *     `alias_target` (указатель OpenRouter на новейшую версию семейства), затем R2;
 *     иначе члены семейства по ключу семейства (у id без токена версии версии не
 *     сравниваются) одного производителя, при дате в id — член с этой датой, иначе
 *     самый новый;
 *  R4 оценка — `intelligence` выбранной версии; нет — следующей по новизне версии
 *     того же семейства, у которой она есть; `resolved` — slug, чья оценка взята.
 *
 * Градация силы (level): `high` — оценка не ниже опоры высокого уровня (`high`), `medium`
 * — выше опоры среднего (`medium`), `low` — не выше неё; оценок нет или пороги не
 * сосчитаны — вычисляемой градации нет (null). Пороги — оценки опорных моделей из тех же
 * данных (levelThresholds), а не числа в коде или конфиге: обновился фид — поехали
 * пороги. Поправка из своей практики (levelOverride) бьёт оценку данных: значение — имя
 * уровня или своя оценка, по которой уровень считается теми же порогами. Строковая
 * поправка (имя уровня) сохраняет уровень даже при несосчитанных порогах — осознанно:
 * наблюдение из практики сильнее и фида, и порогов. `level_source` отличает поправку
 * (`override`) от оценки младшей версии семейства (`older`, правило R4) и от оценки самой
 * модели (`feed`).
 *
 * Бесплатность (первое сработавшее правило):
 *  1. хост kilo, kilo знает ровно этот id и его `isFree` — логическое значение:
 *     флаг поставщика решает в обе стороны (`free_source: kilo`);
 *  2. id оканчивается на `:free` (`openrouter_id`);
 *  3. у прямой записи (R1, а не новейшей версии R2), а у id без прямой записи — у члена
 *     семейства R3 с датой id, числовые `pricing.prompt` и `pricing.completion`:
 *     бесплатна при обоих нулях (`openrouter_price`); новейший член семейства и цель
 *     псевдонима `~…-latest` цену не дают;
 *  4. иначе платная (`unknown`).
 * Цены kilo (`cost.*`) не читаются: `kilo models --verbose` 2026-09-28 даёт
 * `cost.input = cost.output = 0` платным openai/gpt-5.6-luna, -terra и -sol без
 * `isFree` — по цене kilo три платных агента стали бы бесплатными.
 */

const VERSION_TOKEN = /^v?\d+(\.\d+)*$/;
const SHORT_INT = /^\d{1,3}$/;
const SLUG_DATE = /-(\d{8})$/;
const ID_DATE = /-(\d{8}|\d{4})$/;

/** Градация силы модели по оценке — от слабой к сильной (порядок сравнения уровней). */
export const LEVELS = Object.freeze(['low', 'medium', 'high']);

const isAlias = (id) => id.startsWith('~');
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const PROVIDER_ALIASES = new Map([['z-ai', 'zai']]);
const normalizeProvider = (provider) => PROVIDER_ALIASES.get(String(provider).toLowerCase()) ?? String(provider).toLowerCase();
// Варианты написания производителя: сам, канон и обратное канону. Каталог оценок и имена
// моделей у агентов пишут одного производителя по-разному (z-ai в фиде OpenRouter, zai
// в именах kilo) — сравнения вендора не должны зависеть от написания.
const vendorVariants = (provider) => {
  const lower = String(provider).toLowerCase();
  const canonical = normalizeProvider(lower);
  const variants = new Set([lower, canonical]);
  for (const [from, to] of PROVIDER_ALIASES) if (normalizeProvider(to) === canonical) variants.add(from);
  return [...variants];
};

/** Части id модели: маршрут, производитель, имя, имя без варианта, id без маршрута. */
export function splitModelId(id) {
  const segments = String(id).split('/');
  const route = segments.length >= 3 ? segments[0] : null;
  const rest = route ? segments.slice(1) : segments;
  const name = rest[rest.length - 1];
  const colon = name.indexOf(':');
  return {
    route,
    vendor: rest.length >= 2 ? rest[rest.length - 2] : null,
    name,
    base: colon === -1 ? name : name.slice(0, colon),
    variant: colon === -1 ? null : name.slice(colon + 1),
    withoutRoute: rest.join('/'),
  };
}

/** Дата id (`-YYYYMMDD` или `-MMDD` в конце имени без варианта) или null. */
export function idDate(base) {
  return ID_DATE.exec(base)?.[1] ?? null;
}

/** Дата slug (`-YYYYMMDD` в конце) или null. */
export function slugDate(slug) {
  return typeof slug === 'string' ? SLUG_DATE.exec(slug)?.[1] ?? null : null;
}

export function stripSlugDate(slug) {
  return String(slug).replace(SLUG_DATE, '');
}

// Токены имени: нижний регистр, без варианта и даты, короткие числа подряд — версия.
function nameTokens(name, { shortDate }) {
  const tokens = String(name).toLowerCase().split(':')[0].split('-').filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && (/^\d{8}$/.test(last) || (shortDate && /^\d{4}$/.test(last)))) tokens.pop();
  const merged = [];
  let run = [];
  const flush = () => {
    if (run.length > 0) merged.push(run.join('.'));
    run = [];
  };
  for (const token of tokens) {
    if (SHORT_INT.test(token)) {
      run.push(token);
      continue;
    }
    flush();
    merged.push(token);
  }
  flush();
  return merged;
}

/** Ключ семейства имени; `ignoreVersions` — без токенов версии. `shortDate` — `-MMDD` тоже дата (id). */
export function familyKey(name, { ignoreVersions = false, shortDate = true } = {}) {
  const tokens = nameTokens(name, { shortDate });
  return (ignoreVersions ? tokens.filter((t) => !VERSION_TOKEN.test(t)) : tokens).join('-');
}

export function hasVersionToken(name) {
  return nameTokens(name, { shortDate: true }).some((t) => VERSION_TOKEN.test(t));
}

// `created` (unix, с) → YYYYMMDD по UTC.
function createdDate(created) {
  if (!isNumber(created)) return null;
  const date = new Date(created * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Индекс кэша: записи каталога `{ id, slug, vendor, name, meta, date }` и доступ по id.
 * `modelFacts` берёт готовый индекс (`options.index`) или строит свой. В режиме фактов
 * команда строит индекс дважды: первый — до решения об обновлении кэша (по нему
 * считаются ключи, среди них опоры градации), второй — после возможной перезагрузки
 * (прежний смотрит в старый объект кэша); второй делят пороги градации и сами факты.
 */
export function catalogIndex(cache) {
  const catalog = cache?.catalog && typeof cache.catalog === 'object' ? cache.catalog : {};
  const models = cache?.models && typeof cache.models === 'object' ? cache.models : {};
  const benchmarks = cache?.benchmarks && typeof cache.benchmarks === 'object' ? cache.benchmarks : {};
  const byId = new Map();
  const records = [];
  for (const [id, slug] of Object.entries(catalog)) {
    const segments = id.split('/');
    const meta = Object.hasOwn(models, id) && models[id] && typeof models[id] === 'object' ? models[id] : {};
    const record = {
      id,
      slug: typeof slug === 'string' ? slug : null,
      vendor: segments.length >= 2 ? segments[0].replace(/^~/, '') : null,
      name: segments[segments.length - 1],
      meta,
      date: slugDate(slug) ?? createdDate(meta.created),
    };
    byId.set(id, record);
    if (!isAlias(id)) records.push(record);
  }
  return { byId, records, benchmarks };
}

// Сначала новее; при равной дате — запись без варианта (цена и имя основной записи).
function newestFirst(a, b) {
  const byDate = String(b.date ?? '').localeCompare(String(a.date ?? ''));
  if (byDate !== 0) return byDate;
  return Number(a.id.includes(':')) - Number(b.id.includes(':'));
}

/** R1: прямая запись каталога id или null. */
export function directRecord(id, index) {
  const parts = splitModelId(id);
  for (const key of parts.route ? [id, parts.withoutRoute] : [id]) {
    if (index.byId.has(key)) return index.byId.get(key);
  }
  if (!String(id).includes('/')) {
    const matches = index.records.filter((r) => r.id.split('/').pop() === id);
    if (new Set(matches.map((r) => normalizeProvider(r.vendor))).size === 1) return matches.sort(newestFirst)[0];
  }
  return null;
}

// R2: самая новая запись со slug без даты, равным `slug` без даты.
function newestOfSlug(slug, index, alsoId = null) {
  const base = stripSlugDate(slug);
  const siblings = index.records.filter((r) => (r.slug && stripSlugDate(r.slug) === base) || r.id === alsoId);
  return siblings.sort(newestFirst)[0] ?? null;
}

// R3: запись для id без прямой записи — { record, exact } (exact — совпала дата id) или null.
function familyRecord(id, index, warn) {
  const { vendor, base } = splitModelId(id);
  if (vendor) {
    const alias = vendorVariants(vendor)
      .map((spelling) => index.byId.get(`~${spelling}/${base}-latest`))
      .find((found) => found !== undefined);
    const target = typeof alias?.meta?.alias_target === 'string' ? alias.meta.alias_target : null;
    const record = target ? newestOfSlug(target, index, target) : null;
    if (record) return { record, exact: false };
  }
  const ignoreVersions = !hasVersionToken(base);
  const key = familyKey(base, { ignoreVersions });
  const vendors = vendor ? new Set(vendorVariants(vendor).map(normalizeProvider)) : null;
  const members = index.records.filter((r) => (!vendors || vendors.has(normalizeProvider(r.vendor)))
    && (familyKey(r.name, { ignoreVersions }) === key
      || (r.slug && familyKey(r.slug.split('/').pop(), { ignoreVersions, shortDate: false }) === key)));
  if (members.length === 0) return null;
  const memberVendors = [...new Set(members.map((r) => normalizeProvider(r.vendor)))];
  if (memberVendors.length > 1) {
    warn?.(`model "${id}" is ambiguous in the catalog (vendors ${memberVendors.join(', ')}) — no score`);
    return null;
  }
  members.sort(newestFirst);
  const date = idDate(base);
  if (date) {
    const same = members.find((r) => r.date && (date.length === 8 ? r.date === date : r.date.slice(4) === date));
    if (same) return { record: same, exact: true };
  }
  return { record: members[0], exact: false };
}

// R4: оценка slug или следующей по новизне версии семейства с оценкой; `sibling` —
// оценка взята у другой (младшей) версии семейства, а не у самой модели.
function scoreOf(record, index) {
  const row = (slug) => (slug && Object.hasOwn(index.benchmarks, slug) ? index.benchmarks[slug] : null);
  const own = row(record.slug);
  if (own && isNumber(own.intelligence)) return { resolved: record.slug, row: own, sibling: false };
  const key = familyKey(record.name, { ignoreVersions: true });
  const older = index.records
    .filter((r) => normalizeProvider(r.vendor) === normalizeProvider(record.vendor) && r.slug && r.slug !== record.slug
      && familyKey(r.name, { ignoreVersions: true }) === key
      && (!record.date || !r.date || r.date <= record.date))
    .sort(newestFirst);
  for (const candidate of older) {
    const other = row(candidate.slug);
    if (other && isNumber(other.intelligence)) return { resolved: candidate.slug, row: other, sibling: true };
  }
  return { resolved: own ? record.slug : null, row: own, sibling: false };
}

/**
 * Оценка id: { resolved, intelligence, coding, agentic, price, sibling } — `price` —
 * запись, чья цена годится для правила 3 (прямая запись или член семейства с датой id),
 * или null; `sibling` — оценка взята у другой версии семейства (правило R4).
 */
export function resolveScore(id, index, warn = null) {
  let chosen = null;
  let price = null;
  const direct = directRecord(id, index);
  if (direct) {
    price = direct;
    if (isAlias(direct.id)) {
      const target = typeof direct.meta?.alias_target === 'string' ? direct.meta.alias_target : null;
      chosen = target ? newestOfSlug(target, index, target) : null;
    } else if (direct.slug && !idDate(splitModelId(direct.id).base)) {
      chosen = newestOfSlug(direct.slug, index) ?? direct;
    } else {
      chosen = direct;
    }
  } else {
    const family = familyRecord(id, index, warn);
    if (family) {
      chosen = family.record;
      if (family.exact) price = family.record;
    }
  }
  if (!chosen || !chosen.slug) return { resolved: null, intelligence: null, coding: null, agentic: null, price, sibling: false };
  const { resolved, row, sibling } = scoreOf(chosen, index);
  const value = (v) => (isNumber(v) ? v : null);
  return {
    resolved,
    intelligence: value(row?.intelligence),
    coding: value(row?.coding),
    agentic: value(row?.agentic),
    price,
    sibling,
  };
}

/** Порядковый номер уровня (`low` → 0, `high` → 2) или null — не уровень. */
export function levelRank(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? null : index;
}

/**
 * Пороги градации по опорным моделям: `{high, medium}` — оценки опор в тех же данных,
 * что и оценки кандидатов (resolveScore), или null, если опора не оценена. Опоры — id
 * моделей, как их называет агент, или slug. Порядок опор проверяется: `high` не выше
 * `medium` — пороги недействительны (null): иначе градация вывернута. Числа в коде не
 * живут — пороги едут за данными вместе с оценками опорных моделей.
 * @param {object} index — catalogIndex(кэш)
 * @param {{high?: string, medium?: string}} anchors
 * @returns {{high: number|null, medium: number|null, anchors: {high: string|null, medium: string|null}}}
 */
export function levelThresholds(index, anchors = {}, warn = null) {
  const score = (what) => {
    if (typeof what !== 'string' || !what) return null;
    const { intelligence } = resolveScore(what, index);
    return isNumber(intelligence) ? intelligence : null;
  };
  const high = score(anchors.high);
  const medium = score(anchors.medium);
  const named = {
    high: typeof anchors.high === 'string' && anchors.high ? anchors.high : null,
    medium: typeof anchors.medium === 'string' && anchors.medium ? anchors.medium : null,
  };
  if (high === null || medium === null) {
    warn?.(`level anchors not scored (high=${named.high ?? '-'} → ${high}, medium=${named.medium ?? '-'} → ${medium}) — levels not computed`);
    return { high: null, medium: null, anchors: named };
  }
  if (high <= medium) {
    warn?.(`level anchors out of order (high=${named.high} ${high} ≤ medium=${named.medium} ${medium}) — levels not computed`);
    return { high: null, medium: null, anchors: named };
  }
  return { high, medium, anchors: named };
}

/**
 * Уровень оценки: `high` — не ниже опоры высокого уровня, `medium` — выше опоры среднего,
 * `low` — не выше неё. Оценки нет или пороги не сосчитаны — null (уровень неизвестен).
 */
export function levelOfScore(score, thresholds) {
  if (!isNumber(score) || !thresholds || !isNumber(thresholds.high) || !isNumber(thresholds.medium)) return null;
  if (score >= thresholds.high) return 'high';
  if (score > thresholds.medium) return 'medium';
  return 'low';
}

/**
 * Поправка из своей практики для id: ключи поправок сверяются с id, id без маршрута,
 * именем модели (`short`), оценённым slug (`resolved`) и голым именем без производителя
 * (`base`); первое совпадение выигрывает. Группа ключей без производителя (нет `/` —
 * голое имя и как ключ, и как входной id) применяется, только если в каталоге не больше
 * одного производителя с этим именем без варианта; производителей больше — WARN и
 * поправка не применяется (молчаливое применение сразу ко всем недопустимо). Значение —
 * число (своя оценка: уровень по порогам) или имя уровня. Нет поправки — null.
 */
export function levelOverride(id, resolved, overrides, index = null, warn = null) {
  if (!overrides || typeof overrides !== 'object') return null;
  const parts = splitModelId(id);
  const short = parts.vendor ? `${parts.vendor}/${parts.base}` : parts.base;
  // Ключ поправки — в любой из привычных форм: полный id, он же без маршрута, имя модели
  // или slug оценки; вариант (`:free`) и маршрут можно не писать.
  const keys = [];
  for (const raw of [id, parts.withoutRoute, short, resolved, parts.base]) {
    if (typeof raw !== 'string' || !raw) continue;
    for (const form of [raw, raw.replace(/:[^:/]+$/, '')]) {
      if (form && !keys.includes(form)) keys.push(form);
    }
  }
  // Производители имени без варианта: голый ключ (нет '/') берётся, только если он один.
  const vendorsOf = (name) => [...new Set((index?.records ?? [])
    .filter((r) => splitModelId(r.id).base === name)
    .map((r) => r.vendor))];
  for (const key of keys) {
    if (!Object.hasOwn(overrides, key)) continue;
    if (!key.includes('/')) {
      const vendors = vendorsOf(splitModelId(key).base);
      if (vendors.length > 1) {
        warn?.(`level override key "${key}" is ambiguous (vendors ${vendors.join(', ')}) — ignored`);
        continue;
      }
    }
    const value = overrides[key];
    if (typeof value === 'string' && levelRank(value) !== null) return { level: value, score: null, key };
    if (isNumber(value)) return { level: null, score: value, key };
    return { invalid: true, key };
  }
  return null;
}

const priceNumber = (value) => {
  if (isNumber(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Бесплатность строки `{ id, host }` по правилам шапки: `{ free, free_source }`.
 * @param {Map<string, object>|null} kilo — объекты моделей `kilo models --verbose` по id строки
 * @param {object|null} price — запись каталога для правила 3 (resolveScore().price)
 */
export function freeOf({ id, host }, kilo, price) {
  const kiloModel = host === 'kilo' ? kilo?.get(id) : undefined;
  if (typeof kiloModel?.isFree === 'boolean') return { free: kiloModel.isFree, free_source: 'kilo' };
  if (String(id).endsWith(':free')) return { free: true, free_source: 'openrouter_id' };
  const prompt = priceNumber(price?.meta?.prompt);
  const completion = priceNumber(price?.meta?.completion);
  if (prompt !== null && completion !== null) return { free: prompt === 0 && completion === 0, free_source: 'openrouter_price' };
  return { free: false, free_source: 'unknown' };
}

/**
 * Факты строк входа команды: по одной записи на пару id + хост, в порядке входа.
 * Градация (`level`) — по порогам `thresholds` (levelThresholds): поправка из своей
 * практики (`overrides`) бьёт оценку данных; без оценки и без поправки уровень null.
 * `level_source`: `override` — поправка, `older` — оценка младшей версии семейства
 * (правило R4), `feed` — оценка самой модели, null — уровня нет.
 * @param {Array<{id: string, host: string|null}>} lines
 * @param {object} cache — кэш команды оценок
 * @param {Map<string, object>|null} kilo — объекты моделей `kilo models --verbose`
 * @param {{thresholds?: object|null, overrides?: object|null, index?: object|null}} options —
 *   index — готовый индекс каталога (catalogIndex кэша): не задан — строится сам, задан —
 *   переиспользуется (в режиме фактов команды индекс считается один раз)
 */
export function modelFacts(lines, cache, kilo = null, warn = null, { thresholds = null, overrides = null, index = null } = {}) {
  const catalog = index ?? catalogIndex(cache);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = `${line.id}\u0000${line.host ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { price, sibling, ...score } = resolveScore(line.id, catalog, warn);
    const override = levelOverride(line.id, score.resolved, overrides, catalog, warn);
    if (override?.invalid) {
      warn?.(`level override for "${override.key}" is neither a level (${LEVELS.join('/')}) nor a number — ignored`);
    }
    const known = override && !override.invalid ? override : null;
    const level = known?.level ?? levelOfScore(known?.score ?? score.intelligence, thresholds);
    out.push({
      id: line.id,
      host: line.host ?? null,
      ...score,
      ...freeOf(line, kilo, price),
      level: level ?? null,
      level_source: level === null ? null : (known ? 'override' : (sibling ? 'older' : 'feed')),
    });
  }
  return out;
}
