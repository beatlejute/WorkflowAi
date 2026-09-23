/**
 * Счётчик операций с файловой системой для замеров алгоритмической стоимости.
 *
 * Зачем: замер по стенным часам (p95 ≤ 50 мс) падал в полном наборе, когда десяток
 * воркеров одновременно молотит диск, и был зелёным в изоляции — то есть охранял
 * загрузку машины, а не код. Число обращений к диску от соседей по прогону не
 * зависит: лишний проход по каталогу или повторное чтение всех файлов видны точной
 * цифрой при любой нагрузке.
 *
 * Прокси считает вызовы по имени метода и передаёт их настоящему fs: замеряется
 * боевой код на настоящем диске, подмены поведения нет.
 */

import realFs from 'node:fs';

export function createCountingFs(baseFs = realFs) {
  const counts = Object.create(null);

  const proxy = new Proxy(baseFs, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args) => {
        counts[prop] = (counts[prop] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  });

  return {
    fs: proxy,
    counts,
    /** Сколько раз вызван метод (0, если не вызывался ни разу). */
    op(name) {
      return counts[name] ?? 0;
    },
    /** Суммарное число обращений к файловой системе. */
    total() {
      return Object.values(counts).reduce((a, b) => a + b, 0);
    },
    /** Читаемая расшифровка для сообщения ассершена. */
    describe() {
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name}=${n}`)
        .join(' ');
    },
    reset() {
      for (const key of Object.keys(counts)) delete counts[key];
    },
  };
}
