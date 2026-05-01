#!/usr/bin/env node
// @ts-nocheck

/**
 * pick-next-task.js - Скрипт для выбора следующего тикета из директории ready/
 *
 * Использование:
 *   node pick-next-task.js
 *
 * Выводит результат в формате:
 *   ---RESULT---
 *   status: found
 *   ticket_id: IMPL-001
 *   ---RESULT---
 *
 * или если задач нет:
 *   ---RESULT---
 *   status: empty
 *   ---RESULT---
 */
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId, getLastReviewStatus, serializeFrontmatter, loadTicketMovementRules, checkAndClosePlan } from 'workflow-ai/lib/utils.mjs';
import { createLogger } from 'workflow-ai/lib/logger.mjs';
const logger = createLogger();

// Корень проекта
const PROJECT_DIR = findProjectRoot();
// Базовая директория workflow
const WORKFLOW_DIR = path.join(PROJECT_DIR, stryMutAct_9fa48("0") ? "" : (stryCov_9fa48("0"), '.workflow'));
const TICKETS_DIR = path.join(WORKFLOW_DIR, stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), 'tickets'));
const READY_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("2") ? "" : (stryCov_9fa48("2"), 'ready'));
const DONE_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("3") ? "" : (stryCov_9fa48("3"), 'done'));
const IN_PROGRESS_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("4") ? "" : (stryCov_9fa48("4"), 'in-progress'));
const BLOCKED_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("5") ? "" : (stryCov_9fa48("5"), 'blocked'));
const REVIEW_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("6") ? "" : (stryCov_9fa48("6"), 'review'));
const ARCHIVE_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("7") ? "" : (stryCov_9fa48("7"), 'archive'));
const BACKLOG_DIR = path.join(TICKETS_DIR, stryMutAct_9fa48("8") ? "" : (stryCov_9fa48("8"), 'backlog'));

/**
 * Проверяет условие (condition) тикета
 */
function checkCondition(condition) {
  if (stryMutAct_9fa48("9")) {
    {}
  } else {
    stryCov_9fa48("9");
    const {
      type,
      value
    } = condition;
    switch (type) {
      case stryMutAct_9fa48("11") ? "" : (stryCov_9fa48("11"), 'file_exists'):
        if (stryMutAct_9fa48("10")) {} else {
          stryCov_9fa48("10");
          const filePath = path.isAbsolute(value) ? value : path.join(PROJECT_DIR, value);
          return fs.existsSync(filePath);
        }
      case stryMutAct_9fa48("13") ? "" : (stryCov_9fa48("13"), 'file_not_exists'):
        if (stryMutAct_9fa48("12")) {} else {
          stryCov_9fa48("12");
          const filePath2 = path.isAbsolute(value) ? value : path.join(PROJECT_DIR, value);
          return stryMutAct_9fa48("14") ? fs.existsSync(filePath2) : (stryCov_9fa48("14"), !fs.existsSync(filePath2));
        }
      case stryMutAct_9fa48("16") ? "" : (stryCov_9fa48("16"), 'tasks_completed'):
        if (stryMutAct_9fa48("15")) {} else {
          stryCov_9fa48("15");
          // Проверяет, что указанные задачи выполнены (находятся в done/)
          if (stryMutAct_9fa48("19") ? !value && Array.isArray(value) && value.length === 0 : stryMutAct_9fa48("18") ? false : stryMutAct_9fa48("17") ? true : (stryCov_9fa48("17", "18", "19"), (stryMutAct_9fa48("20") ? value : (stryCov_9fa48("20"), !value)) || (stryMutAct_9fa48("22") ? Array.isArray(value) || value.length === 0 : stryMutAct_9fa48("21") ? false : (stryCov_9fa48("21", "22"), Array.isArray(value) && (stryMutAct_9fa48("24") ? value.length !== 0 : stryMutAct_9fa48("23") ? true : (stryCov_9fa48("23", "24"), value.length === 0)))))) return stryMutAct_9fa48("25") ? false : (stryCov_9fa48("25"), true);
          const ids = Array.isArray(value) ? value : stryMutAct_9fa48("26") ? [] : (stryCov_9fa48("26"), [value]);
          return stryMutAct_9fa48("27") ? ids.some(taskId => {
            const donePath = path.join(DONE_DIR, `${taskId}.md`);
            const archivePath = path.join(ARCHIVE_DIR, `${taskId}.md`);
            return fs.existsSync(donePath) || fs.existsSync(archivePath);
          }) : (stryCov_9fa48("27"), ids.every(taskId => {
            if (stryMutAct_9fa48("28")) {
              {}
            } else {
              stryCov_9fa48("28");
              const donePath = path.join(DONE_DIR, stryMutAct_9fa48("29") ? `` : (stryCov_9fa48("29"), `${taskId}.md`));
              const archivePath = path.join(ARCHIVE_DIR, stryMutAct_9fa48("30") ? `` : (stryCov_9fa48("30"), `${taskId}.md`));
              return stryMutAct_9fa48("33") ? fs.existsSync(donePath) && fs.existsSync(archivePath) : stryMutAct_9fa48("32") ? false : stryMutAct_9fa48("31") ? true : (stryCov_9fa48("31", "32", "33"), fs.existsSync(donePath) || fs.existsSync(archivePath));
            }
          }));
        }
      case stryMutAct_9fa48("35") ? "" : (stryCov_9fa48("35"), 'date_after'):
        if (stryMutAct_9fa48("34")) {} else {
          stryCov_9fa48("34");
          return stryMutAct_9fa48("39") ? new Date() <= new Date(value) : stryMutAct_9fa48("38") ? new Date() >= new Date(value) : stryMutAct_9fa48("37") ? false : stryMutAct_9fa48("36") ? true : (stryCov_9fa48("36", "37", "38", "39"), new Date() > new Date(value));
        }
      case stryMutAct_9fa48("41") ? "" : (stryCov_9fa48("41"), 'date_before'):
        if (stryMutAct_9fa48("40")) {} else {
          stryCov_9fa48("40");
          return stryMutAct_9fa48("45") ? new Date() >= new Date(value) : stryMutAct_9fa48("44") ? new Date() <= new Date(value) : stryMutAct_9fa48("43") ? false : stryMutAct_9fa48("42") ? true : (stryCov_9fa48("42", "43", "44", "45"), new Date() < new Date(value));
        }
      case stryMutAct_9fa48("47") ? "" : (stryCov_9fa48("47"), 'manual_approval'):
        if (stryMutAct_9fa48("46")) {} else {
          stryCov_9fa48("46");
          // Для ручного подтверждения всегда возвращаем false
          // Требуется явное одобрение
          return stryMutAct_9fa48("48") ? true : (stryCov_9fa48("48"), false);
        }
      default:
        if (stryMutAct_9fa48("49")) {} else {
          stryCov_9fa48("49");
          logger.warn(stryMutAct_9fa48("50") ? `` : (stryCov_9fa48("50"), `Unknown condition type: ${type}`));
          return stryMutAct_9fa48("51") ? false : (stryCov_9fa48("51"), true);
        }
    }
  }
}

/**
 * Парсит секцию "## Ревью" тикета и возвращает все записи ревью.
 * @param {string} content - Содержимое тикета
 * @returns {Array<{date: string, status: string, comment: string}>}
 */
function parseReviewSection(content) {
  if (stryMutAct_9fa48("52")) {
    {}
  } else {
    stryCov_9fa48("52");
    if (stryMutAct_9fa48("55") ? false : stryMutAct_9fa48("54") ? true : stryMutAct_9fa48("53") ? content : (stryCov_9fa48("53", "54", "55"), !content)) return stryMutAct_9fa48("56") ? ["Stryker was here"] : (stryCov_9fa48("56"), []);
    const headerIdx = content.search(stryMutAct_9fa48("62") ? /^##\s*Ревью\S*$/m : stryMutAct_9fa48("61") ? /^##\s*Ревью\s$/m : stryMutAct_9fa48("60") ? /^##\S*Ревью\s*$/m : stryMutAct_9fa48("59") ? /^##\sРевью\s*$/m : stryMutAct_9fa48("58") ? /^##\s*Ревью\s*/m : stryMutAct_9fa48("57") ? /##\s*Ревью\s*$/m : (stryCov_9fa48("57", "58", "59", "60", "61", "62"), /^##\s*Ревью\s*$/m));
    if (stryMutAct_9fa48("65") ? headerIdx !== -1 : stryMutAct_9fa48("64") ? false : stryMutAct_9fa48("63") ? true : (stryCov_9fa48("63", "64", "65"), headerIdx === (stryMutAct_9fa48("66") ? +1 : (stryCov_9fa48("66"), -1)))) return stryMutAct_9fa48("67") ? ["Stryker was here"] : (stryCov_9fa48("67"), []);
    const bodyStart = content.indexOf(stryMutAct_9fa48("68") ? "" : (stryCov_9fa48("68"), '\n'), headerIdx);
    if (stryMutAct_9fa48("71") ? bodyStart !== -1 : stryMutAct_9fa48("70") ? false : stryMutAct_9fa48("69") ? true : (stryCov_9fa48("69", "70", "71"), bodyStart === (stryMutAct_9fa48("72") ? +1 : (stryCov_9fa48("72"), -1)))) return stryMutAct_9fa48("73") ? ["Stryker was here"] : (stryCov_9fa48("73"), []);
    const nextH2 = content.indexOf(stryMutAct_9fa48("74") ? "" : (stryCov_9fa48("74"), '\n## '), bodyStart);
    const reviewSection = stryMutAct_9fa48("75") ? nextH2 === -1 ? content.slice(bodyStart + 1) : content.slice(bodyStart + 1, nextH2) : (stryCov_9fa48("75"), ((stryMutAct_9fa48("78") ? nextH2 !== -1 : stryMutAct_9fa48("77") ? false : stryMutAct_9fa48("76") ? true : (stryCov_9fa48("76", "77", "78"), nextH2 === (stryMutAct_9fa48("79") ? +1 : (stryCov_9fa48("79"), -1)))) ? stryMutAct_9fa48("80") ? content : (stryCov_9fa48("80"), content.slice(stryMutAct_9fa48("81") ? bodyStart - 1 : (stryCov_9fa48("81"), bodyStart + 1))) : stryMutAct_9fa48("82") ? content : (stryCov_9fa48("82"), content.slice(stryMutAct_9fa48("83") ? bodyStart - 1 : (stryCov_9fa48("83"), bodyStart + 1), nextH2))).trim());
    const reviews = stryMutAct_9fa48("84") ? ["Stryker was here"] : (stryCov_9fa48("84"), []);
    const tableRows = stryMutAct_9fa48("85") ? reviewSection.split('\n') : (stryCov_9fa48("85"), reviewSection.split(stryMutAct_9fa48("86") ? "" : (stryCov_9fa48("86"), '\n')).filter(stryMutAct_9fa48("87") ? () => undefined : (stryCov_9fa48("87"), line => stryMutAct_9fa48("89") ? line.startsWith('|') : stryMutAct_9fa48("88") ? line.trim().endsWith('|') : (stryCov_9fa48("88", "89"), line.trim().startsWith(stryMutAct_9fa48("90") ? "" : (stryCov_9fa48("90"), '|'))))));
    if (stryMutAct_9fa48("94") ? tableRows.length < 2 : stryMutAct_9fa48("93") ? tableRows.length > 2 : stryMutAct_9fa48("92") ? false : stryMutAct_9fa48("91") ? true : (stryCov_9fa48("91", "92", "93", "94"), tableRows.length >= 2)) {
      if (stryMutAct_9fa48("95")) {
        {}
      } else {
        stryCov_9fa48("95");
        const dataRows = stryMutAct_9fa48("97") ? tableRows.filter(row => {
          const cells = row.split('|').map(c => c.trim()).filter(c => c);
          return cells.length >= 2;
        }) : stryMutAct_9fa48("96") ? tableRows.slice(2) : (stryCov_9fa48("96", "97"), tableRows.slice(2).filter(row => {
          if (stryMutAct_9fa48("98")) {
            {}
          } else {
            stryCov_9fa48("98");
            const cells = stryMutAct_9fa48("99") ? row.split('|').map(c => c.trim()) : (stryCov_9fa48("99"), row.split(stryMutAct_9fa48("100") ? "" : (stryCov_9fa48("100"), '|')).map(stryMutAct_9fa48("101") ? () => undefined : (stryCov_9fa48("101"), c => stryMutAct_9fa48("102") ? c : (stryCov_9fa48("102"), c.trim()))).filter(stryMutAct_9fa48("103") ? () => undefined : (stryCov_9fa48("103"), c => c)));
            return stryMutAct_9fa48("107") ? cells.length < 2 : stryMutAct_9fa48("106") ? cells.length > 2 : stryMutAct_9fa48("105") ? false : stryMutAct_9fa48("104") ? true : (stryCov_9fa48("104", "105", "106", "107"), cells.length >= 2);
          }
        }));
        for (const row of dataRows) {
          if (stryMutAct_9fa48("108")) {
            {}
          } else {
            stryCov_9fa48("108");
            const cells = stryMutAct_9fa48("109") ? row.split('|').map(c => c.trim()) : (stryCov_9fa48("109"), row.split(stryMutAct_9fa48("110") ? "" : (stryCov_9fa48("110"), '|')).map(stryMutAct_9fa48("111") ? () => undefined : (stryCov_9fa48("111"), c => stryMutAct_9fa48("112") ? c : (stryCov_9fa48("112"), c.trim()))).filter(stryMutAct_9fa48("113") ? () => undefined : (stryCov_9fa48("113"), c => c)));
            const date = stryMutAct_9fa48("116") ? cells[0] && '' : stryMutAct_9fa48("115") ? false : stryMutAct_9fa48("114") ? true : (stryCov_9fa48("114", "115", "116"), cells[0] || (stryMutAct_9fa48("117") ? "Stryker was here!" : (stryCov_9fa48("117"), '')));
            const statusRaw = stryMutAct_9fa48("120") ? cells[1]?.toLowerCase() && '' : stryMutAct_9fa48("119") ? false : stryMutAct_9fa48("118") ? true : (stryCov_9fa48("118", "119", "120"), (stryMutAct_9fa48("122") ? cells[1].toLowerCase() : stryMutAct_9fa48("121") ? cells[1]?.toUpperCase() : (stryCov_9fa48("121", "122"), cells[1]?.toLowerCase())) || (stryMutAct_9fa48("123") ? "Stryker was here!" : (stryCov_9fa48("123"), '')));
            const comment = stryMutAct_9fa48("126") ? cells[2] && '' : stryMutAct_9fa48("125") ? false : stryMutAct_9fa48("124") ? true : (stryCov_9fa48("124", "125", "126"), cells[2] || (stryMutAct_9fa48("127") ? "Stryker was here!" : (stryCov_9fa48("127"), '')));
            let status = null;
            if (stryMutAct_9fa48("129") ? false : stryMutAct_9fa48("128") ? true : (stryCov_9fa48("128", "129"), statusRaw.includes(stryMutAct_9fa48("130") ? "" : (stryCov_9fa48("130"), 'passed')))) status = stryMutAct_9fa48("131") ? "" : (stryCov_9fa48("131"), 'passed');else if (stryMutAct_9fa48("133") ? false : stryMutAct_9fa48("132") ? true : (stryCov_9fa48("132", "133"), statusRaw.includes(stryMutAct_9fa48("134") ? "" : (stryCov_9fa48("134"), 'failed')))) status = stryMutAct_9fa48("135") ? "" : (stryCov_9fa48("135"), 'failed');else if (stryMutAct_9fa48("137") ? false : stryMutAct_9fa48("136") ? true : (stryCov_9fa48("136", "137"), statusRaw.includes(stryMutAct_9fa48("138") ? "" : (stryCov_9fa48("138"), 'skipped')))) status = stryMutAct_9fa48("139") ? "" : (stryCov_9fa48("139"), 'skipped');
            if (stryMutAct_9fa48("141") ? false : stryMutAct_9fa48("140") ? true : (stryCov_9fa48("140", "141"), status)) {
              if (stryMutAct_9fa48("142")) {
                {}
              } else {
                stryCov_9fa48("142");
                reviews.push(stryMutAct_9fa48("143") ? {} : (stryCov_9fa48("143"), {
                  date,
                  status,
                  comment
                }));
              }
            }
          }
        }
      }
    }
    const listItems = stryMutAct_9fa48("144") ? reviewSection.split('\n') : (stryCov_9fa48("144"), reviewSection.split(stryMutAct_9fa48("145") ? "" : (stryCov_9fa48("145"), '\n')).filter(stryMutAct_9fa48("146") ? () => undefined : (stryCov_9fa48("146"), line => stryMutAct_9fa48("147") ? line.match(/^[-*]\s/) : (stryCov_9fa48("147"), line.trim().match(stryMutAct_9fa48("150") ? /^[-*]\S/ : stryMutAct_9fa48("149") ? /^[^-*]\s/ : stryMutAct_9fa48("148") ? /[-*]\s/ : (stryCov_9fa48("148", "149", "150"), /^[-*]\s/))))));
    for (const item of listItems) {
      if (stryMutAct_9fa48("151")) {
        {}
      } else {
        stryCov_9fa48("151");
        const trimmed = stryMutAct_9fa48("152") ? item : (stryCov_9fa48("152"), item.trim());
        const dateMatch = trimmed.match(stryMutAct_9fa48("162") ? /^[-*]\s*(\d{4}-\d{2}-\D{2})/ : stryMutAct_9fa48("161") ? /^[-*]\s*(\d{4}-\d{2}-\d)/ : stryMutAct_9fa48("160") ? /^[-*]\s*(\d{4}-\D{2}-\d{2})/ : stryMutAct_9fa48("159") ? /^[-*]\s*(\d{4}-\d-\d{2})/ : stryMutAct_9fa48("158") ? /^[-*]\s*(\D{4}-\d{2}-\d{2})/ : stryMutAct_9fa48("157") ? /^[-*]\s*(\d-\d{2}-\d{2})/ : stryMutAct_9fa48("156") ? /^[-*]\S*(\d{4}-\d{2}-\d{2})/ : stryMutAct_9fa48("155") ? /^[-*]\s(\d{4}-\d{2}-\d{2})/ : stryMutAct_9fa48("154") ? /^[^-*]\s*(\d{4}-\d{2}-\d{2})/ : stryMutAct_9fa48("153") ? /[-*]\s*(\d{4}-\d{2}-\d{2})/ : (stryCov_9fa48("153", "154", "155", "156", "157", "158", "159", "160", "161", "162"), /^[-*]\s*(\d{4}-\d{2}-\d{2})/));
        const statusMatch = trimmed.match(stryMutAct_9fa48("164") ? /:\S*(passed|failed|skipped)\b/i : stryMutAct_9fa48("163") ? /:\s(passed|failed|skipped)\b/i : (stryCov_9fa48("163", "164"), /:\s*(passed|failed|skipped)\b/i));
        if (stryMutAct_9fa48("167") ? dateMatch || statusMatch : stryMutAct_9fa48("166") ? false : stryMutAct_9fa48("165") ? true : (stryCov_9fa48("165", "166", "167"), dateMatch && statusMatch)) {
          if (stryMutAct_9fa48("168")) {
            {}
          } else {
            stryCov_9fa48("168");
            reviews.push(stryMutAct_9fa48("169") ? {} : (stryCov_9fa48("169"), {
              date: dateMatch[1],
              status: stryMutAct_9fa48("170") ? statusMatch[1].toUpperCase() : (stryCov_9fa48("170"), statusMatch[1].toLowerCase()),
              comment: stryMutAct_9fa48("171") ? trimmed.replace(/^[-*]\s*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i, '') : (stryCov_9fa48("171"), trimmed.replace(stryMutAct_9fa48("183") ? /^[-*]\s*\d{4}-\d{2}-\d{2}:\S*(passed|failed|skipped)\b/i : stryMutAct_9fa48("182") ? /^[-*]\s*\d{4}-\d{2}-\d{2}:\s(passed|failed|skipped)\b/i : stryMutAct_9fa48("181") ? /^[-*]\s*\d{4}-\d{2}-\D{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("180") ? /^[-*]\s*\d{4}-\d{2}-\d:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("179") ? /^[-*]\s*\d{4}-\D{2}-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("178") ? /^[-*]\s*\d{4}-\d-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("177") ? /^[-*]\s*\D{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("176") ? /^[-*]\s*\d-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("175") ? /^[-*]\S*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("174") ? /^[-*]\s\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("173") ? /^[^-*]\s*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i : stryMutAct_9fa48("172") ? /[-*]\s*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i : (stryCov_9fa48("172", "173", "174", "175", "176", "177", "178", "179", "180", "181", "182", "183"), /^[-*]\s*\d{4}-\d{2}-\d{2}:\s*(passed|failed|skipped)\b/i), stryMutAct_9fa48("184") ? "Stryker was here!" : (stryCov_9fa48("184"), '')).trim())
            }));
          }
        }
      }
    }
    return reviews;
  }
}

/**
 * Вычисляет метрики ревью-итераций для всех тикетов
 * @returns {object} Метрики: iterations, avgTimeToFirstPassed, failedVsPassed
 */
function calculateReviewMetrics() {
  if (stryMutAct_9fa48("185")) {
    {}
  } else {
    stryCov_9fa48("185");
    const allDirs = stryMutAct_9fa48("186") ? [] : (stryCov_9fa48("186"), [BACKLOG_DIR, READY_DIR, IN_PROGRESS_DIR, BLOCKED_DIR, REVIEW_DIR, DONE_DIR, ARCHIVE_DIR]);
    const ticketMetrics = {};
    let totalFailed = 0;
    let totalPassed = 0;
    let firstPassedTimes = stryMutAct_9fa48("187") ? ["Stryker was here"] : (stryCov_9fa48("187"), []);
    for (const dir of allDirs) {
      if (stryMutAct_9fa48("188")) {
        {}
      } else {
        stryCov_9fa48("188");
        if (stryMutAct_9fa48("191") ? false : stryMutAct_9fa48("190") ? true : stryMutAct_9fa48("189") ? fs.existsSync(dir) : (stryCov_9fa48("189", "190", "191"), !fs.existsSync(dir))) continue;
        const files = stryMutAct_9fa48("192") ? fs.readdirSync(dir) : (stryCov_9fa48("192"), fs.readdirSync(dir).filter(stryMutAct_9fa48("193") ? () => undefined : (stryCov_9fa48("193"), f => stryMutAct_9fa48("196") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("195") ? false : stryMutAct_9fa48("194") ? true : (stryCov_9fa48("194", "195", "196"), (stryMutAct_9fa48("197") ? f.startsWith('.md') : (stryCov_9fa48("197"), f.endsWith(stryMutAct_9fa48("198") ? "" : (stryCov_9fa48("198"), '.md')))) && (stryMutAct_9fa48("200") ? f === '.gitkeep.md' : stryMutAct_9fa48("199") ? true : (stryCov_9fa48("199", "200"), f !== (stryMutAct_9fa48("201") ? "" : (stryCov_9fa48("201"), '.gitkeep.md'))))))));
        for (const file of files) {
          if (stryMutAct_9fa48("202")) {
            {}
          } else {
            stryCov_9fa48("202");
            const filePath = path.join(dir, file);
            try {
              if (stryMutAct_9fa48("203")) {
                {}
              } else {
                stryCov_9fa48("203");
                const content = fs.readFileSync(filePath, stryMutAct_9fa48("204") ? "" : (stryCov_9fa48("204"), 'utf8'));
                const {
                  frontmatter
                } = parseFrontmatter(content);
                const ticketId = stryMutAct_9fa48("207") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("206") ? false : stryMutAct_9fa48("205") ? true : (stryCov_9fa48("205", "206", "207"), frontmatter.id || file.replace(stryMutAct_9fa48("208") ? "" : (stryCov_9fa48("208"), '.md'), stryMutAct_9fa48("209") ? "Stryker was here!" : (stryCov_9fa48("209"), '')));
                const reviews = parseReviewSection(content);
                if (stryMutAct_9fa48("212") ? reviews.length !== 0 : stryMutAct_9fa48("211") ? false : stryMutAct_9fa48("210") ? true : (stryCov_9fa48("210", "211", "212"), reviews.length === 0)) continue;
                ticketMetrics[ticketId] = reviews.length;
                for (const review of reviews) {
                  if (stryMutAct_9fa48("213")) {
                    {}
                  } else {
                    stryCov_9fa48("213");
                    if (stryMutAct_9fa48("216") ? review.status !== 'failed' : stryMutAct_9fa48("215") ? false : stryMutAct_9fa48("214") ? true : (stryCov_9fa48("214", "215", "216"), review.status === (stryMutAct_9fa48("217") ? "" : (stryCov_9fa48("217"), 'failed')))) stryMutAct_9fa48("218") ? totalFailed-- : (stryCov_9fa48("218"), totalFailed++);else if (stryMutAct_9fa48("221") ? review.status !== 'passed' : stryMutAct_9fa48("220") ? false : stryMutAct_9fa48("219") ? true : (stryCov_9fa48("219", "220", "221"), review.status === (stryMutAct_9fa48("222") ? "" : (stryCov_9fa48("222"), 'passed')))) stryMutAct_9fa48("223") ? totalPassed-- : (stryCov_9fa48("223"), totalPassed++);
                  }
                }
                const firstPassed = reviews.find(stryMutAct_9fa48("224") ? () => undefined : (stryCov_9fa48("224"), r => stryMutAct_9fa48("227") ? r.status !== 'passed' : stryMutAct_9fa48("226") ? false : stryMutAct_9fa48("225") ? true : (stryCov_9fa48("225", "226", "227"), r.status === (stryMutAct_9fa48("228") ? "" : (stryCov_9fa48("228"), 'passed')))));
                if (stryMutAct_9fa48("231") ? firstPassed || firstPassed.date : stryMutAct_9fa48("230") ? false : stryMutAct_9fa48("229") ? true : (stryCov_9fa48("229", "230", "231"), firstPassed && firstPassed.date)) {
                  if (stryMutAct_9fa48("232")) {
                    {}
                  } else {
                    stryCov_9fa48("232");
                    const ticketCreated = new Date(stryMutAct_9fa48("235") ? frontmatter.created_at && '1970-01-01' : stryMutAct_9fa48("234") ? false : stryMutAct_9fa48("233") ? true : (stryCov_9fa48("233", "234", "235"), frontmatter.created_at || (stryMutAct_9fa48("236") ? "" : (stryCov_9fa48("236"), '1970-01-01'))));
                    const passedDate = new Date(firstPassed.date);
                    const daysToPass = Math.floor(stryMutAct_9fa48("237") ? (passedDate - ticketCreated) * (1000 * 60 * 60 * 24) : (stryCov_9fa48("237"), (stryMutAct_9fa48("238") ? passedDate + ticketCreated : (stryCov_9fa48("238"), passedDate - ticketCreated)) / (stryMutAct_9fa48("239") ? 1000 * 60 * 60 / 24 : (stryCov_9fa48("239"), (stryMutAct_9fa48("240") ? 1000 * 60 / 60 : (stryCov_9fa48("240"), (stryMutAct_9fa48("241") ? 1000 / 60 : (stryCov_9fa48("241"), 1000 * 60)) * 60)) * 24))));
                    if (stryMutAct_9fa48("245") ? daysToPass < 0 : stryMutAct_9fa48("244") ? daysToPass > 0 : stryMutAct_9fa48("243") ? false : stryMutAct_9fa48("242") ? true : (stryCov_9fa48("242", "243", "244", "245"), daysToPass >= 0)) {
                      if (stryMutAct_9fa48("246")) {
                        {}
                      } else {
                        stryCov_9fa48("246");
                        firstPassedTimes.push(daysToPass);
                      }
                    }
                  }
                }
              }
            } catch (e) {
              // Skip errors
            }
          }
        }
      }
    }
    const avgTimeToFirstPassed = (stryMutAct_9fa48("250") ? firstPassedTimes.length <= 0 : stryMutAct_9fa48("249") ? firstPassedTimes.length >= 0 : stryMutAct_9fa48("248") ? false : stryMutAct_9fa48("247") ? true : (stryCov_9fa48("247", "248", "249", "250"), firstPassedTimes.length > 0)) ? Math.round(stryMutAct_9fa48("251") ? firstPassedTimes.reduce((a, b) => a + b, 0) * firstPassedTimes.length : (stryCov_9fa48("251"), firstPassedTimes.reduce(stryMutAct_9fa48("252") ? () => undefined : (stryCov_9fa48("252"), (a, b) => stryMutAct_9fa48("253") ? a - b : (stryCov_9fa48("253"), a + b)), 0) / firstPassedTimes.length)) : null;
    return stryMutAct_9fa48("254") ? {} : (stryCov_9fa48("254"), {
      iterations_per_ticket: ticketMetrics,
      total_failed: totalFailed,
      total_passed: totalPassed,
      avg_time_to_first_passed_days: avgTimeToFirstPassed,
      tickets_with_reviews: Object.keys(ticketMetrics).length
    });
  }
}

/**
 * Проверяет зависимости тикета
 */
function checkDependencies(dependencies) {
  if (stryMutAct_9fa48("255")) {
    {}
  } else {
    stryCov_9fa48("255");
    if (stryMutAct_9fa48("258") ? !dependencies && dependencies.length === 0 : stryMutAct_9fa48("257") ? false : stryMutAct_9fa48("256") ? true : (stryCov_9fa48("256", "257", "258"), (stryMutAct_9fa48("259") ? dependencies : (stryCov_9fa48("259"), !dependencies)) || (stryMutAct_9fa48("261") ? dependencies.length !== 0 : stryMutAct_9fa48("260") ? false : (stryCov_9fa48("260", "261"), dependencies.length === 0)))) {
      if (stryMutAct_9fa48("262")) {
        {}
      } else {
        stryCov_9fa48("262");
        return stryMutAct_9fa48("263") ? false : (stryCov_9fa48("263"), true);
      }
    }
    return stryMutAct_9fa48("264") ? dependencies.some(depId => {
      const donePath = path.join(DONE_DIR, `${depId}.md`);
      const archivePath = path.join(ARCHIVE_DIR, `${depId}.md`);
      return fs.existsSync(donePath) || fs.existsSync(archivePath);
    }) : (stryCov_9fa48("264"), dependencies.every(depId => {
      if (stryMutAct_9fa48("265")) {
        {}
      } else {
        stryCov_9fa48("265");
        const donePath = path.join(DONE_DIR, stryMutAct_9fa48("266") ? `` : (stryCov_9fa48("266"), `${depId}.md`));
        const archivePath = path.join(ARCHIVE_DIR, stryMutAct_9fa48("267") ? `` : (stryCov_9fa48("267"), `${depId}.md`));
        return stryMutAct_9fa48("270") ? fs.existsSync(donePath) && fs.existsSync(archivePath) : stryMutAct_9fa48("269") ? false : stryMutAct_9fa48("268") ? true : (stryCov_9fa48("268", "269", "270"), fs.existsSync(donePath) || fs.existsSync(archivePath));
      }
    }));
  }
}

/**
 * Авто-коррекция тикетов на основе статуса ревью.
 * Сканирует все директории и перемещает тикеты по правилам из конфига.
 *
 * @param {object} config - Конфигурация правил перемещения
 * @returns {object} Результат: { moved: Array<{id, from, to, reason}> }
 */
function autoCorrectTickets(config) {
  if (stryMutAct_9fa48("271")) {
    {}
  } else {
    stryCov_9fa48("271");
    const moved = stryMutAct_9fa48("272") ? ["Stryker was here"] : (stryCov_9fa48("272"), []);
    const dirMap = stryMutAct_9fa48("273") ? {} : (stryCov_9fa48("273"), {
      backlog: BACKLOG_DIR,
      ready: READY_DIR,
      in_progress: IN_PROGRESS_DIR,
      blocked: BLOCKED_DIR,
      review: REVIEW_DIR,
      done: DONE_DIR,
      archive: ARCHIVE_DIR
    });

    /**
     * Перемещает тикет из одной директории в другую
     */
    function moveTicket(ticketId, fromDir, toDir, reason) {
      if (stryMutAct_9fa48("274")) {
        {}
      } else {
        stryCov_9fa48("274");
        const fromPath = path.join(fromDir, stryMutAct_9fa48("275") ? `` : (stryCov_9fa48("275"), `${ticketId}.md`));
        const toPath = path.join(toDir, stryMutAct_9fa48("276") ? `` : (stryCov_9fa48("276"), `${ticketId}.md`));
        if (stryMutAct_9fa48("279") ? false : stryMutAct_9fa48("278") ? true : stryMutAct_9fa48("277") ? fs.existsSync(fromPath) : (stryCov_9fa48("277", "278", "279"), !fs.existsSync(fromPath))) {
          if (stryMutAct_9fa48("280")) {
            {}
          } else {
            stryCov_9fa48("280");
            return stryMutAct_9fa48("281") ? true : (stryCov_9fa48("281"), false);
          }
        }
        try {
          if (stryMutAct_9fa48("282")) {
            {}
          } else {
            stryCov_9fa48("282");
            const content = fs.readFileSync(fromPath, stryMutAct_9fa48("283") ? "" : (stryCov_9fa48("283"), 'utf8'));
            const {
              frontmatter,
              body
            } = parseFrontmatter(content);
            frontmatter.updated_at = new Date().toISOString();
            if (stryMutAct_9fa48("286") ? toDir === DONE_DIR || !frontmatter.completed_at : stryMutAct_9fa48("285") ? false : stryMutAct_9fa48("284") ? true : (stryCov_9fa48("284", "285", "286"), (stryMutAct_9fa48("288") ? toDir !== DONE_DIR : stryMutAct_9fa48("287") ? true : (stryCov_9fa48("287", "288"), toDir === DONE_DIR)) && (stryMutAct_9fa48("289") ? frontmatter.completed_at : (stryCov_9fa48("289"), !frontmatter.completed_at)))) {
              if (stryMutAct_9fa48("290")) {
                {}
              } else {
                stryCov_9fa48("290");
                frontmatter.completed_at = new Date().toISOString();
              }
            }
            const newContent = stryMutAct_9fa48("291") ? serializeFrontmatter(frontmatter) - body : (stryCov_9fa48("291"), serializeFrontmatter(frontmatter) + body);
            fs.writeFileSync(toPath, newContent, stryMutAct_9fa48("292") ? "" : (stryCov_9fa48("292"), 'utf8'));
            fs.unlinkSync(fromPath);
            console.log(stryMutAct_9fa48("293") ? `` : (stryCov_9fa48("293"), `[AUTO-CORRECT] ${ticketId}: ${path.basename(fromDir)} → ${path.basename(toDir)} (${reason})`));
            moved.push(stryMutAct_9fa48("294") ? {} : (stryCov_9fa48("294"), {
              id: ticketId,
              from: path.basename(fromDir),
              to: path.basename(toDir),
              reason
            }));
            return stryMutAct_9fa48("295") ? false : (stryCov_9fa48("295"), true);
          }
        } catch (e) {
          if (stryMutAct_9fa48("296")) {
            {}
          } else {
            stryCov_9fa48("296");
            logger.error(stryMutAct_9fa48("297") ? `` : (stryCov_9fa48("297"), `Failed to move ticket ${ticketId}: ${e.message}`));
            return stryMutAct_9fa48("298") ? true : (stryCov_9fa48("298"), false);
          }
        }
      }
    }

    /**
     * Обрабатывает тикеты в указанной директории
     */
    function processDirectory(dir, rules, dirName) {
      if (stryMutAct_9fa48("299")) {
        {}
      } else {
        stryCov_9fa48("299");
        if (stryMutAct_9fa48("302") ? false : stryMutAct_9fa48("301") ? true : stryMutAct_9fa48("300") ? fs.existsSync(dir) : (stryCov_9fa48("300", "301", "302"), !fs.existsSync(dir))) return;
        const files = stryMutAct_9fa48("303") ? fs.readdirSync(dir) : (stryCov_9fa48("303"), fs.readdirSync(dir).filter(stryMutAct_9fa48("304") ? () => undefined : (stryCov_9fa48("304"), f => stryMutAct_9fa48("307") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("306") ? false : stryMutAct_9fa48("305") ? true : (stryCov_9fa48("305", "306", "307"), (stryMutAct_9fa48("308") ? f.startsWith('.md') : (stryCov_9fa48("308"), f.endsWith(stryMutAct_9fa48("309") ? "" : (stryCov_9fa48("309"), '.md')))) && (stryMutAct_9fa48("311") ? f === '.gitkeep.md' : stryMutAct_9fa48("310") ? true : (stryCov_9fa48("310", "311"), f !== (stryMutAct_9fa48("312") ? "" : (stryCov_9fa48("312"), '.gitkeep.md'))))))));
        for (const file of files) {
          if (stryMutAct_9fa48("313")) {
            {}
          } else {
            stryCov_9fa48("313");
            const filePath = path.join(dir, file);
            try {
              if (stryMutAct_9fa48("314")) {
                {}
              } else {
                stryCov_9fa48("314");
                const content = fs.readFileSync(filePath, stryMutAct_9fa48("315") ? "" : (stryCov_9fa48("315"), 'utf8'));
                const {
                  frontmatter
                } = parseFrontmatter(content);
                const ticketId = stryMutAct_9fa48("318") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("317") ? false : stryMutAct_9fa48("316") ? true : (stryCov_9fa48("316", "317", "318"), frontmatter.id || file.replace(stryMutAct_9fa48("319") ? "" : (stryCov_9fa48("319"), '.md'), stryMutAct_9fa48("320") ? "Stryker was here!" : (stryCov_9fa48("320"), '')));
                const reviewStatus = getLastReviewStatus(content);
                for (const rule of rules) {
                  if (stryMutAct_9fa48("321")) {
                    {}
                  } else {
                    stryCov_9fa48("321");
                    const ruleCondition = rule.condition;
                    let shouldMove = stryMutAct_9fa48("322") ? true : (stryCov_9fa48("322"), false);
                    if (stryMutAct_9fa48("325") ? ruleCondition !== null : stryMutAct_9fa48("324") ? false : stryMutAct_9fa48("323") ? true : (stryCov_9fa48("323", "324", "325"), ruleCondition === null)) {
                      if (stryMutAct_9fa48("326")) {
                        {}
                      } else {
                        stryCov_9fa48("326");
                        shouldMove = stryMutAct_9fa48("329") ? reviewStatus !== null : stryMutAct_9fa48("328") ? false : stryMutAct_9fa48("327") ? true : (stryCov_9fa48("327", "328", "329"), reviewStatus === null);
                      }
                    } else {
                      if (stryMutAct_9fa48("330")) {
                        {}
                      } else {
                        stryCov_9fa48("330");
                        shouldMove = stryMutAct_9fa48("333") ? reviewStatus !== ruleCondition : stryMutAct_9fa48("332") ? false : stryMutAct_9fa48("331") ? true : (stryCov_9fa48("331", "332", "333"), reviewStatus === ruleCondition);
                      }
                    }
                    if (stryMutAct_9fa48("335") ? false : stryMutAct_9fa48("334") ? true : (stryCov_9fa48("334", "335"), shouldMove)) {
                      if (stryMutAct_9fa48("336")) {
                        {}
                      } else {
                        stryCov_9fa48("336");
                        const targetDirName = rule.to_dir;
                        const targetDir = dirMap[targetDirName];
                        if (stryMutAct_9fa48("338") ? false : stryMutAct_9fa48("337") ? true : (stryCov_9fa48("337", "338"), targetDir)) {
                          if (stryMutAct_9fa48("339")) {
                            {}
                          } else {
                            stryCov_9fa48("339");
                            moveTicket(ticketId, dir, targetDir, rule.reason);
                          }
                        }
                        break;
                      }
                    }
                  }
                }
              }
            } catch (e) {
              if (stryMutAct_9fa48("340")) {
                {}
              } else {
                stryCov_9fa48("340");
                logger.warn(stryMutAct_9fa48("341") ? `` : (stryCov_9fa48("341"), `Failed to process ticket ${file}: ${e.message}`));
              }
            }
          }
        }
      }
    }
    if (stryMutAct_9fa48("344") ? !config && !config.rules : stryMutAct_9fa48("343") ? false : stryMutAct_9fa48("342") ? true : (stryCov_9fa48("342", "343", "344"), (stryMutAct_9fa48("345") ? config : (stryCov_9fa48("345"), !config)) || (stryMutAct_9fa48("346") ? config.rules : (stryCov_9fa48("346"), !config.rules)))) {
      if (stryMutAct_9fa48("347")) {
        {}
      } else {
        stryCov_9fa48("347");
        logger.error(stryMutAct_9fa48("348") ? "" : (stryCov_9fa48("348"), 'Ticket movement rules config not loaded'));
        return stryMutAct_9fa48("349") ? {} : (stryCov_9fa48("349"), {
          moved
        });
      }
    }
    const rulesConfig = config.rules;
    for (const [dirName, rules] of Object.entries(rulesConfig)) {
      if (stryMutAct_9fa48("350")) {
        {}
      } else {
        stryCov_9fa48("350");
        const dir = dirMap[dirName];
        if (stryMutAct_9fa48("352") ? false : stryMutAct_9fa48("351") ? true : (stryCov_9fa48("351", "352"), dir)) {
          if (stryMutAct_9fa48("353")) {
            {}
          } else {
            stryCov_9fa48("353");
            processDirectory(dir, rules, dirName);
          }
        }
      }
    }
    return stryMutAct_9fa48("354") ? {} : (stryCov_9fa48("354"), {
      moved
    });
  }
}

/**
 * Считывает все тикеты из директории ready/
 */
function readReadyTickets() {
  if (stryMutAct_9fa48("355")) {
    {}
  } else {
    stryCov_9fa48("355");
    if (stryMutAct_9fa48("358") ? false : stryMutAct_9fa48("357") ? true : stryMutAct_9fa48("356") ? fs.existsSync(READY_DIR) : (stryCov_9fa48("356", "357", "358"), !fs.existsSync(READY_DIR))) {
      if (stryMutAct_9fa48("359")) {
        {}
      } else {
        stryCov_9fa48("359");
        return stryMutAct_9fa48("360") ? ["Stryker was here"] : (stryCov_9fa48("360"), []);
      }
    }
    const files = stryMutAct_9fa48("361") ? fs.readdirSync(READY_DIR) : (stryCov_9fa48("361"), fs.readdirSync(READY_DIR).filter(stryMutAct_9fa48("362") ? () => undefined : (stryCov_9fa48("362"), f => stryMutAct_9fa48("365") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("364") ? false : stryMutAct_9fa48("363") ? true : (stryCov_9fa48("363", "364", "365"), (stryMutAct_9fa48("366") ? f.startsWith('.md') : (stryCov_9fa48("366"), f.endsWith(stryMutAct_9fa48("367") ? "" : (stryCov_9fa48("367"), '.md')))) && (stryMutAct_9fa48("369") ? f === '.gitkeep.md' : stryMutAct_9fa48("368") ? true : (stryCov_9fa48("368", "369"), f !== (stryMutAct_9fa48("370") ? "" : (stryCov_9fa48("370"), '.gitkeep.md'))))))));
    const tickets = stryMutAct_9fa48("371") ? ["Stryker was here"] : (stryCov_9fa48("371"), []);
    for (const file of files) {
      if (stryMutAct_9fa48("372")) {
        {}
      } else {
        stryCov_9fa48("372");
        const filePath = path.join(READY_DIR, file);
        try {
          if (stryMutAct_9fa48("373")) {
            {}
          } else {
            stryCov_9fa48("373");
            const content = fs.readFileSync(filePath, stryMutAct_9fa48("374") ? "" : (stryCov_9fa48("374"), 'utf8'));
            const {
              frontmatter
            } = parseFrontmatter(content);
            tickets.push(stryMutAct_9fa48("375") ? {} : (stryCov_9fa48("375"), {
              id: stryMutAct_9fa48("378") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("377") ? false : stryMutAct_9fa48("376") ? true : (stryCov_9fa48("376", "377", "378"), frontmatter.id || file.replace(stryMutAct_9fa48("379") ? "" : (stryCov_9fa48("379"), '.md'), stryMutAct_9fa48("380") ? "Stryker was here!" : (stryCov_9fa48("380"), ''))),
              frontmatter,
              filePath
            }));
          }
        } catch (e) {
          if (stryMutAct_9fa48("381")) {
            {}
          } else {
            stryCov_9fa48("381");
            console.error(stryMutAct_9fa48("382") ? `` : (stryCov_9fa48("382"), `[WARN] Failed to read ticket ${file}: ${e.message}`));
          }
        }
      }
    }
    return tickets;
  }
}

/**
 * Считывает все тикеты из директории review/
 */
function readReviewTickets() {
  if (stryMutAct_9fa48("383")) {
    {}
  } else {
    stryCov_9fa48("383");
    if (stryMutAct_9fa48("386") ? false : stryMutAct_9fa48("385") ? true : stryMutAct_9fa48("384") ? fs.existsSync(path.join(TICKETS_DIR, 'review')) : (stryCov_9fa48("384", "385", "386"), !fs.existsSync(path.join(TICKETS_DIR, stryMutAct_9fa48("387") ? "" : (stryCov_9fa48("387"), 'review'))))) {
      if (stryMutAct_9fa48("388")) {
        {}
      } else {
        stryCov_9fa48("388");
        return stryMutAct_9fa48("389") ? ["Stryker was here"] : (stryCov_9fa48("389"), []);
      }
    }
    const files = stryMutAct_9fa48("390") ? fs.readdirSync(path.join(TICKETS_DIR, 'review')) : (stryCov_9fa48("390"), fs.readdirSync(path.join(TICKETS_DIR, stryMutAct_9fa48("391") ? "" : (stryCov_9fa48("391"), 'review'))).filter(stryMutAct_9fa48("392") ? () => undefined : (stryCov_9fa48("392"), f => stryMutAct_9fa48("395") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("394") ? false : stryMutAct_9fa48("393") ? true : (stryCov_9fa48("393", "394", "395"), (stryMutAct_9fa48("396") ? f.startsWith('.md') : (stryCov_9fa48("396"), f.endsWith(stryMutAct_9fa48("397") ? "" : (stryCov_9fa48("397"), '.md')))) && (stryMutAct_9fa48("399") ? f === '.gitkeep.md' : stryMutAct_9fa48("398") ? true : (stryCov_9fa48("398", "399"), f !== (stryMutAct_9fa48("400") ? "" : (stryCov_9fa48("400"), '.gitkeep.md'))))))));
    const tickets = stryMutAct_9fa48("401") ? ["Stryker was here"] : (stryCov_9fa48("401"), []);
    for (const file of files) {
      if (stryMutAct_9fa48("402")) {
        {}
      } else {
        stryCov_9fa48("402");
        const filePath = path.join(TICKETS_DIR, stryMutAct_9fa48("403") ? "" : (stryCov_9fa48("403"), 'review'), file);
        try {
          if (stryMutAct_9fa48("404")) {
            {}
          } else {
            stryCov_9fa48("404");
            const content = fs.readFileSync(filePath, stryMutAct_9fa48("405") ? "" : (stryCov_9fa48("405"), 'utf8'));
            const {
              frontmatter
            } = parseFrontmatter(content);
            tickets.push(stryMutAct_9fa48("406") ? {} : (stryCov_9fa48("406"), {
              id: stryMutAct_9fa48("409") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("408") ? false : stryMutAct_9fa48("407") ? true : (stryCov_9fa48("407", "408", "409"), frontmatter.id || file.replace(stryMutAct_9fa48("410") ? "" : (stryCov_9fa48("410"), '.md'), stryMutAct_9fa48("411") ? "Stryker was here!" : (stryCov_9fa48("411"), ''))),
              frontmatter,
              filePath
            }));
          }
        } catch (e) {
          if (stryMutAct_9fa48("412")) {
            {}
          } else {
            stryCov_9fa48("412");
            console.error(stryMutAct_9fa48("413") ? `` : (stryCov_9fa48("413"), `[WARN] Failed to read ticket ${file}: ${e.message}`));
          }
        }
      }
    }
    return tickets;
  }
}

/**
 * Считывает все тикеты из директории in-progress/
 */
function readInProgressTickets() {
  if (stryMutAct_9fa48("414")) {
    {}
  } else {
    stryCov_9fa48("414");
    if (stryMutAct_9fa48("417") ? false : stryMutAct_9fa48("416") ? true : stryMutAct_9fa48("415") ? fs.existsSync(IN_PROGRESS_DIR) : (stryCov_9fa48("415", "416", "417"), !fs.existsSync(IN_PROGRESS_DIR))) {
      if (stryMutAct_9fa48("418")) {
        {}
      } else {
        stryCov_9fa48("418");
        return stryMutAct_9fa48("419") ? ["Stryker was here"] : (stryCov_9fa48("419"), []);
      }
    }
    const files = stryMutAct_9fa48("420") ? fs.readdirSync(IN_PROGRESS_DIR) : (stryCov_9fa48("420"), fs.readdirSync(IN_PROGRESS_DIR).filter(stryMutAct_9fa48("421") ? () => undefined : (stryCov_9fa48("421"), f => stryMutAct_9fa48("424") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("423") ? false : stryMutAct_9fa48("422") ? true : (stryCov_9fa48("422", "423", "424"), (stryMutAct_9fa48("425") ? f.startsWith('.md') : (stryCov_9fa48("425"), f.endsWith(stryMutAct_9fa48("426") ? "" : (stryCov_9fa48("426"), '.md')))) && (stryMutAct_9fa48("428") ? f === '.gitkeep.md' : stryMutAct_9fa48("427") ? true : (stryCov_9fa48("427", "428"), f !== (stryMutAct_9fa48("429") ? "" : (stryCov_9fa48("429"), '.gitkeep.md'))))))));
    const tickets = stryMutAct_9fa48("430") ? ["Stryker was here"] : (stryCov_9fa48("430"), []);
    for (const file of files) {
      if (stryMutAct_9fa48("431")) {
        {}
      } else {
        stryCov_9fa48("431");
        const filePath = path.join(IN_PROGRESS_DIR, file);
        try {
          if (stryMutAct_9fa48("432")) {
            {}
          } else {
            stryCov_9fa48("432");
            const content = fs.readFileSync(filePath, stryMutAct_9fa48("433") ? "" : (stryCov_9fa48("433"), 'utf8'));
            const {
              frontmatter
            } = parseFrontmatter(content);
            tickets.push(stryMutAct_9fa48("434") ? {} : (stryCov_9fa48("434"), {
              id: stryMutAct_9fa48("437") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("436") ? false : stryMutAct_9fa48("435") ? true : (stryCov_9fa48("435", "436", "437"), frontmatter.id || file.replace(stryMutAct_9fa48("438") ? "" : (stryCov_9fa48("438"), '.md'), stryMutAct_9fa48("439") ? "Stryker was here!" : (stryCov_9fa48("439"), ''))),
              frontmatter,
              filePath
            }));
          }
        } catch (e) {
          if (stryMutAct_9fa48("440")) {
            {}
          } else {
            stryCov_9fa48("440");
            console.error(stryMutAct_9fa48("441") ? `` : (stryCov_9fa48("441"), `[WARN] Failed to read in-progress ticket ${file}: ${e.message}`));
          }
        }
      }
    }
    return tickets;
  }
}

/**
 * Проверяет, заполнен ли раздел результатов (Summary) в тикете
 */
function hasFilledResult(body) {
  if (stryMutAct_9fa48("442")) {
    {}
  } else {
    stryCov_9fa48("442");
    const resultSectionRegex = stryMutAct_9fa48("448") ? /^##\s*(Результат выполнения|Result)\S*$/m : stryMutAct_9fa48("447") ? /^##\s*(Результат выполнения|Result)\s$/m : stryMutAct_9fa48("446") ? /^##\S*(Результат выполнения|Result)\s*$/m : stryMutAct_9fa48("445") ? /^##\s(Результат выполнения|Result)\s*$/m : stryMutAct_9fa48("444") ? /^##\s*(Результат выполнения|Result)\s*/m : stryMutAct_9fa48("443") ? /##\s*(Результат выполнения|Result)\s*$/m : (stryCov_9fa48("443", "444", "445", "446", "447", "448"), /^##\s*(Результат выполнения|Result)\s*$/m);
    const sectionStart = body.search(resultSectionRegex);
    if (stryMutAct_9fa48("451") ? sectionStart !== -1 : stryMutAct_9fa48("450") ? false : stryMutAct_9fa48("449") ? true : (stryCov_9fa48("449", "450", "451"), sectionStart === (stryMutAct_9fa48("452") ? +1 : (stryCov_9fa48("452"), -1)))) {
      if (stryMutAct_9fa48("453")) {
        {}
      } else {
        stryCov_9fa48("453");
        return stryMutAct_9fa48("454") ? true : (stryCov_9fa48("454"), false);
      }
    }
    const nextSectionRegex = stryMutAct_9fa48("457") ? /^##\S+/gm : stryMutAct_9fa48("456") ? /^##\s/gm : stryMutAct_9fa48("455") ? /##\s+/gm : (stryCov_9fa48("455", "456", "457"), /^##\s+/gm);
    nextSectionRegex.lastIndex = stryMutAct_9fa48("458") ? sectionStart - 1 : (stryCov_9fa48("458"), sectionStart + 1);
    const nextSectionMatch = nextSectionRegex.exec(body);
    const sectionEnd = nextSectionMatch ? nextSectionMatch.index : body.length;
    const sectionContent = stryMutAct_9fa48("459") ? body : (stryCov_9fa48("459"), body.substring(sectionStart, sectionEnd));
    const summaryRegex = stryMutAct_9fa48("465") ? /^###\s*(Summary|Что сделано)\S*$/m : stryMutAct_9fa48("464") ? /^###\s*(Summary|Что сделано)\s$/m : stryMutAct_9fa48("463") ? /^###\S*(Summary|Что сделано)\s*$/m : stryMutAct_9fa48("462") ? /^###\s(Summary|Что сделано)\s*$/m : stryMutAct_9fa48("461") ? /^###\s*(Summary|Что сделано)\s*/m : stryMutAct_9fa48("460") ? /###\s*(Summary|Что сделано)\s*$/m : (stryCov_9fa48("460", "461", "462", "463", "464", "465"), /^###\s*(Summary|Что сделано)\s*$/m);
    const summaryStart = sectionContent.search(summaryRegex);
    if (stryMutAct_9fa48("468") ? summaryStart !== -1 : stryMutAct_9fa48("467") ? false : stryMutAct_9fa48("466") ? true : (stryCov_9fa48("466", "467", "468"), summaryStart === (stryMutAct_9fa48("469") ? +1 : (stryCov_9fa48("469"), -1)))) {
      if (stryMutAct_9fa48("470")) {
        {}
      } else {
        stryCov_9fa48("470");
        return stryMutAct_9fa48("471") ? true : (stryCov_9fa48("471"), false);
      }
    }
    const nextSubsectionRegex = stryMutAct_9fa48("474") ? /^###\S+/gm : stryMutAct_9fa48("473") ? /^###\s/gm : stryMutAct_9fa48("472") ? /###\s+/gm : (stryCov_9fa48("472", "473", "474"), /^###\s+/gm);
    nextSubsectionRegex.lastIndex = stryMutAct_9fa48("475") ? summaryStart - 1 : (stryCov_9fa48("475"), summaryStart + 1);
    const nextSubsectionMatch = nextSubsectionRegex.exec(sectionContent);
    const summaryEnd = nextSubsectionMatch ? nextSubsectionMatch.index : sectionContent.length;
    const summaryContent = stryMutAct_9fa48("476") ? sectionContent : (stryCov_9fa48("476"), sectionContent.substring(summaryStart, summaryEnd));
    const withoutComments = stryMutAct_9fa48("477") ? summaryContent.replace(/<!--[\s\S]*?-->/g, '') : (stryCov_9fa48("477"), summaryContent.replace(stryMutAct_9fa48("481") ? /<!--[\s\s]*?-->/g : stryMutAct_9fa48("480") ? /<!--[\S\S]*?-->/g : stryMutAct_9fa48("479") ? /<!--[^\s\S]*?-->/g : stryMutAct_9fa48("478") ? /<!--[\s\S]-->/g : (stryCov_9fa48("478", "479", "480", "481"), /<!--[\s\S]*?-->/g), stryMutAct_9fa48("482") ? "Stryker was here!" : (stryCov_9fa48("482"), '')).trim());
    return stryMutAct_9fa48("486") ? withoutComments.length <= 0 : stryMutAct_9fa48("485") ? withoutComments.length >= 0 : stryMutAct_9fa48("484") ? false : stryMutAct_9fa48("483") ? true : (stryCov_9fa48("483", "484", "485", "486"), withoutComments.length > 0);
  }
}

/**
 * Находит завершённые тикеты в in-progress/ (с заполненным Summary)
 * Возвращает массив id тикетов
 */
function findCompletedInProgress() {
  if (stryMutAct_9fa48("487")) {
    {}
  } else {
    stryCov_9fa48("487");
    if (stryMutAct_9fa48("490") ? false : stryMutAct_9fa48("489") ? true : stryMutAct_9fa48("488") ? fs.existsSync(IN_PROGRESS_DIR) : (stryCov_9fa48("488", "489", "490"), !fs.existsSync(IN_PROGRESS_DIR))) {
      if (stryMutAct_9fa48("491")) {
        {}
      } else {
        stryCov_9fa48("491");
        return stryMutAct_9fa48("492") ? ["Stryker was here"] : (stryCov_9fa48("492"), []);
      }
    }
    const files = stryMutAct_9fa48("493") ? fs.readdirSync(IN_PROGRESS_DIR) : (stryCov_9fa48("493"), fs.readdirSync(IN_PROGRESS_DIR).filter(stryMutAct_9fa48("494") ? () => undefined : (stryCov_9fa48("494"), f => stryMutAct_9fa48("497") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("496") ? false : stryMutAct_9fa48("495") ? true : (stryCov_9fa48("495", "496", "497"), (stryMutAct_9fa48("498") ? f.startsWith('.md') : (stryCov_9fa48("498"), f.endsWith(stryMutAct_9fa48("499") ? "" : (stryCov_9fa48("499"), '.md')))) && (stryMutAct_9fa48("501") ? f === '.gitkeep.md' : stryMutAct_9fa48("500") ? true : (stryCov_9fa48("500", "501"), f !== (stryMutAct_9fa48("502") ? "" : (stryCov_9fa48("502"), '.gitkeep.md'))))))));
    const completed = stryMutAct_9fa48("503") ? ["Stryker was here"] : (stryCov_9fa48("503"), []);
    for (const file of files) {
      if (stryMutAct_9fa48("504")) {
        {}
      } else {
        stryCov_9fa48("504");
        const filePath = path.join(IN_PROGRESS_DIR, file);
        try {
          if (stryMutAct_9fa48("505")) {
            {}
          } else {
            stryCov_9fa48("505");
            const content = fs.readFileSync(filePath, stryMutAct_9fa48("506") ? "" : (stryCov_9fa48("506"), 'utf8'));
            const {
              frontmatter,
              body
            } = parseFrontmatter(content);
            if (stryMutAct_9fa48("509") ? false : stryMutAct_9fa48("508") ? true : stryMutAct_9fa48("507") ? hasFilledResult(body) : (stryCov_9fa48("507", "508", "509"), !hasFilledResult(body))) {
              if (stryMutAct_9fa48("510")) {
                {}
              } else {
                stryCov_9fa48("510");
                continue;
              }
            }
            completed.push(stryMutAct_9fa48("511") ? {} : (stryCov_9fa48("511"), {
              id: stryMutAct_9fa48("514") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("513") ? false : stryMutAct_9fa48("512") ? true : (stryCov_9fa48("512", "513", "514"), frontmatter.id || file.replace(stryMutAct_9fa48("515") ? "" : (stryCov_9fa48("515"), '.md'), stryMutAct_9fa48("516") ? "Stryker was here!" : (stryCov_9fa48("516"), ''))),
              frontmatter,
              filePath
            }));
          }
        } catch (e) {
          if (stryMutAct_9fa48("517")) {
            {}
          } else {
            stryCov_9fa48("517");
            console.error(stryMutAct_9fa48("518") ? `` : (stryCov_9fa48("518"), `[WARN] Failed to read in-progress ticket ${file}: ${e.message}`));
          }
        }
      }
    }
    return completed;
  }
}

/**
 * Выбирает следующий тикет для выполнения
 */
function filterByPlan(tickets, planId) {
  if (stryMutAct_9fa48("519")) {
    {}
  } else {
    stryCov_9fa48("519");
    if (stryMutAct_9fa48("522") ? false : stryMutAct_9fa48("521") ? true : stryMutAct_9fa48("520") ? planId : (stryCov_9fa48("520", "521", "522"), !planId)) return tickets;
    return stryMutAct_9fa48("523") ? tickets : (stryCov_9fa48("523"), tickets.filter(stryMutAct_9fa48("524") ? () => undefined : (stryCov_9fa48("524"), t => stryMutAct_9fa48("527") ? normalizePlanId(t.frontmatter.parent_plan) !== planId : stryMutAct_9fa48("526") ? false : stryMutAct_9fa48("525") ? true : (stryCov_9fa48("525", "526", "527"), normalizePlanId(t.frontmatter.parent_plan) === planId))));
  }
}
function pickNextTicket(planId) {
  if (stryMutAct_9fa48("528")) {
    {}
  } else {
    stryCov_9fa48("528");
    const tickets = filterByPlan(readReadyTickets(), planId);
    if (stryMutAct_9fa48("531") ? tickets.length !== 0 : stryMutAct_9fa48("530") ? false : stryMutAct_9fa48("529") ? true : (stryCov_9fa48("529", "530", "531"), tickets.length === 0)) {
      if (stryMutAct_9fa48("532")) {
        {}
      } else {
        stryCov_9fa48("532");
        // Если ready/ пуст, проверяем review/ — нужно завершить ревью
        let reviewTickets = filterByPlan(readReviewTickets(), planId);
        if (stryMutAct_9fa48("535") ? reviewTickets.length !== 0 : stryMutAct_9fa48("534") ? false : stryMutAct_9fa48("533") ? true : (stryCov_9fa48("533", "534", "535"), reviewTickets.length === 0)) {
          if (stryMutAct_9fa48("536")) {
            {}
          } else {
            stryCov_9fa48("536");
            // Нет тикетов ни в ready/, ни в review/ — проверяем in-progress/
            // на завершённые тикеты (с заполненным Summary)
            const completedInProgress = filterByPlan(findCompletedInProgress(), planId);
            if (stryMutAct_9fa48("540") ? completedInProgress.length <= 0 : stryMutAct_9fa48("539") ? completedInProgress.length >= 0 : stryMutAct_9fa48("538") ? false : stryMutAct_9fa48("537") ? true : (stryCov_9fa48("537", "538", "539", "540"), completedInProgress.length > 0)) {
              if (stryMutAct_9fa48("541")) {
                {}
              } else {
                stryCov_9fa48("541");
                const first = completedInProgress[0];
                logger.info(stryMutAct_9fa48("542") ? `` : (stryCov_9fa48("542"), `Found completed ticket in in-progress/: ${first.id}`));
                return stryMutAct_9fa48("543") ? {} : (stryCov_9fa48("543"), {
                  status: stryMutAct_9fa48("544") ? "" : (stryCov_9fa48("544"), 'completed_in_progress'),
                  ticket_id: first.id
                });
              }
            }

            // Нет завершённых — проверяем незавершённые тикеты в in-progress/
            const allInProgress = filterByPlan(readInProgressTickets(), planId);
            if (stryMutAct_9fa48("548") ? allInProgress.length <= 0 : stryMutAct_9fa48("547") ? allInProgress.length >= 0 : stryMutAct_9fa48("546") ? false : stryMutAct_9fa48("545") ? true : (stryCov_9fa48("545", "546", "547", "548"), allInProgress.length > 0)) {
              if (stryMutAct_9fa48("549")) {
                {}
              } else {
                stryCov_9fa48("549");
                const first = allInProgress[0];
                logger.info(stryMutAct_9fa48("550") ? `` : (stryCov_9fa48("550"), `Found incomplete ticket in in-progress/: ${first.id}`));
                return stryMutAct_9fa48("551") ? {} : (stryCov_9fa48("551"), {
                  status: stryMutAct_9fa48("552") ? "" : (stryCov_9fa48("552"), 'in_progress'),
                  ticket_id: first.id,
                  priority: first.frontmatter.priority,
                  title: first.frontmatter.title,
                  type: first.frontmatter.type,
                  required_capabilities: JSON.stringify(stryMutAct_9fa48("555") ? first.frontmatter.required_capabilities && [] : stryMutAct_9fa48("554") ? false : stryMutAct_9fa48("553") ? true : (stryCov_9fa48("553", "554", "555"), first.frontmatter.required_capabilities || (stryMutAct_9fa48("556") ? ["Stryker was here"] : (stryCov_9fa48("556"), []))))
                });
              }
            }
          }
        }
        if (stryMutAct_9fa48("560") ? reviewTickets.length <= 0 : stryMutAct_9fa48("559") ? reviewTickets.length >= 0 : stryMutAct_9fa48("558") ? false : stryMutAct_9fa48("557") ? true : (stryCov_9fa48("557", "558", "559", "560"), reviewTickets.length > 0)) {
          if (stryMutAct_9fa48("561")) {
            {}
          } else {
            stryCov_9fa48("561");
            return stryMutAct_9fa48("562") ? {} : (stryCov_9fa48("562"), {
              status: stryMutAct_9fa48("563") ? "" : (stryCov_9fa48("563"), 'in_review'),
              ticket_id: reviewTickets[0].id,
              priority: reviewTickets[0].frontmatter.priority,
              title: reviewTickets[0].frontmatter.title,
              type: reviewTickets[0].frontmatter.type,
              required_capabilities: JSON.stringify(stryMutAct_9fa48("566") ? reviewTickets[0].frontmatter.required_capabilities && [] : stryMutAct_9fa48("565") ? false : stryMutAct_9fa48("564") ? true : (stryCov_9fa48("564", "565", "566"), reviewTickets[0].frontmatter.required_capabilities || (stryMutAct_9fa48("567") ? ["Stryker was here"] : (stryCov_9fa48("567"), []))))
            });
          }
        }
        return stryMutAct_9fa48("568") ? {} : (stryCov_9fa48("568"), {
          status: stryMutAct_9fa48("569") ? "" : (stryCov_9fa48("569"), 'empty'),
          reason: stryMutAct_9fa48("570") ? "" : (stryCov_9fa48("570"), 'No tickets in ready/')
        });
      }
    }

    // Фильтрация: разделяем на обычные и human с проверкой условий/зависимостей
    const eligibleNonHuman = stryMutAct_9fa48("571") ? ["Stryker was here"] : (stryCov_9fa48("571"), []);
    const humanCandidates = stryMutAct_9fa48("572") ? ["Stryker was here"] : (stryCov_9fa48("572"), []);
    for (const ticket of tickets) {
      if (stryMutAct_9fa48("573")) {
        {}
      } else {
        stryCov_9fa48("573");
        const {
          frontmatter
        } = ticket;

        // Проверка условий
        const conditions = stryMutAct_9fa48("576") ? frontmatter.conditions && [] : stryMutAct_9fa48("575") ? false : stryMutAct_9fa48("574") ? true : (stryCov_9fa48("574", "575", "576"), frontmatter.conditions || (stryMutAct_9fa48("577") ? ["Stryker was here"] : (stryCov_9fa48("577"), [])));
        const conditionsMet = stryMutAct_9fa48("578") ? conditions.some(checkCondition) : (stryCov_9fa48("578"), conditions.every(checkCondition));
        if (stryMutAct_9fa48("581") ? false : stryMutAct_9fa48("580") ? true : stryMutAct_9fa48("579") ? conditionsMet : (stryCov_9fa48("579", "580", "581"), !conditionsMet)) {
          if (stryMutAct_9fa48("582")) {
            {}
          } else {
            stryCov_9fa48("582");
            continue;
          }
        }

        // Проверка зависимостей
        const dependencies = stryMutAct_9fa48("585") ? frontmatter.dependencies && [] : stryMutAct_9fa48("584") ? false : stryMutAct_9fa48("583") ? true : (stryCov_9fa48("583", "584", "585"), frontmatter.dependencies || (stryMutAct_9fa48("586") ? ["Stryker was here"] : (stryCov_9fa48("586"), [])));
        const depsMet = checkDependencies(dependencies);
        if (stryMutAct_9fa48("589") ? false : stryMutAct_9fa48("588") ? true : stryMutAct_9fa48("587") ? depsMet : (stryCov_9fa48("587", "588", "589"), !depsMet)) {
          if (stryMutAct_9fa48("590")) {
            {}
          } else {
            stryCov_9fa48("590");
            continue;
          }
        }

        // Обнаружение и удаление дубликатов: тикет не должен существовать в других колонках
        const ticketFileName = stryMutAct_9fa48("591") ? `` : (stryCov_9fa48("591"), `${ticket.id}.md`);
        const otherDirs = stryMutAct_9fa48("592") ? [] : (stryCov_9fa48("592"), [DONE_DIR, IN_PROGRESS_DIR, REVIEW_DIR, BLOCKED_DIR]);
        const duplicateDir = otherDirs.find(stryMutAct_9fa48("593") ? () => undefined : (stryCov_9fa48("593"), dir => fs.existsSync(path.join(dir, ticketFileName))));
        if (stryMutAct_9fa48("595") ? false : stryMutAct_9fa48("594") ? true : (stryCov_9fa48("594", "595"), duplicateDir)) {
          if (stryMutAct_9fa48("596")) {
            {}
          } else {
            stryCov_9fa48("596");
            const dirName = path.basename(duplicateDir);
            logger.warn(stryMutAct_9fa48("597") ? `` : (stryCov_9fa48("597"), `Duplicate detected: ${ticket.id} exists in ready/ and ${dirName}/. Moving ready/ copy to archive/`));
            const archivePath = path.join(ARCHIVE_DIR, ticketFileName);
            try {
              if (stryMutAct_9fa48("598")) {
                {}
              } else {
                stryCov_9fa48("598");
                fs.mkdirSync(ARCHIVE_DIR, stryMutAct_9fa48("599") ? {} : (stryCov_9fa48("599"), {
                  recursive: stryMutAct_9fa48("600") ? false : (stryCov_9fa48("600"), true)
                }));
                fs.renameSync(ticket.filePath, archivePath);
              }
            } catch (err) {
              if (stryMutAct_9fa48("601")) {
                {}
              } else {
                stryCov_9fa48("601");
                logger.error(stryMutAct_9fa48("602") ? `` : (stryCov_9fa48("602"), `Failed to archive duplicate ${ticket.id}: ${err.message}`));
              }
            }
            continue;
          }
        }

        // Разделение по типу
        if (stryMutAct_9fa48("605") ? frontmatter.type !== 'human' : stryMutAct_9fa48("604") ? false : stryMutAct_9fa48("603") ? true : (stryCov_9fa48("603", "604", "605"), frontmatter.type === (stryMutAct_9fa48("606") ? "" : (stryCov_9fa48("606"), 'human')))) {
          if (stryMutAct_9fa48("607")) {
            {}
          } else {
            stryCov_9fa48("607");
            humanCandidates.push(ticket);
          }
        } else {
          if (stryMutAct_9fa48("608")) {
            {}
          } else {
            stryCov_9fa48("608");
            eligibleNonHuman.push(ticket);
          }
        }
      }
    }

    // Имеются ли обычные (non-human) готовые тикеты — старший приоритет
    if (stryMutAct_9fa48("612") ? eligibleNonHuman.length <= 0 : stryMutAct_9fa48("611") ? eligibleNonHuman.length >= 0 : stryMutAct_9fa48("610") ? false : stryMutAct_9fa48("609") ? true : (stryCov_9fa48("609", "610", "611", "612"), eligibleNonHuman.length > 0)) {
      if (stryMutAct_9fa48("613")) {
        {}
      } else {
        stryCov_9fa48("613");
        stryMutAct_9fa48("614") ? eligibleNonHuman : (stryCov_9fa48("614"), eligibleNonHuman.sort((a, b) => {
          if (stryMutAct_9fa48("615")) {
            {}
          } else {
            stryCov_9fa48("615");
            const priorityA = stryMutAct_9fa48("618") ? a.frontmatter.priority && 999 : stryMutAct_9fa48("617") ? false : stryMutAct_9fa48("616") ? true : (stryCov_9fa48("616", "617", "618"), a.frontmatter.priority || 999);
            const priorityB = stryMutAct_9fa48("621") ? b.frontmatter.priority && 999 : stryMutAct_9fa48("620") ? false : stryMutAct_9fa48("619") ? true : (stryCov_9fa48("619", "620", "621"), b.frontmatter.priority || 999);
            if (stryMutAct_9fa48("624") ? priorityA === priorityB : stryMutAct_9fa48("623") ? false : stryMutAct_9fa48("622") ? true : (stryCov_9fa48("622", "623", "624"), priorityA !== priorityB)) {
              if (stryMutAct_9fa48("625")) {
                {}
              } else {
                stryCov_9fa48("625");
                return stryMutAct_9fa48("626") ? priorityA + priorityB : (stryCov_9fa48("626"), priorityA - priorityB);
              }
            }
            const dateA = new Date(stryMutAct_9fa48("629") ? a.frontmatter.created_at && '9999-12-31' : stryMutAct_9fa48("628") ? false : stryMutAct_9fa48("627") ? true : (stryCov_9fa48("627", "628", "629"), a.frontmatter.created_at || (stryMutAct_9fa48("630") ? "" : (stryCov_9fa48("630"), '9999-12-31'))));
            const dateB = new Date(stryMutAct_9fa48("633") ? b.frontmatter.created_at && '9999-12-31' : stryMutAct_9fa48("632") ? false : stryMutAct_9fa48("631") ? true : (stryCov_9fa48("631", "632", "633"), b.frontmatter.created_at || (stryMutAct_9fa48("634") ? "" : (stryCov_9fa48("634"), '9999-12-31'))));
            return stryMutAct_9fa48("635") ? dateA + dateB : (stryCov_9fa48("635"), dateA - dateB);
          }
        }));
        const selected = eligibleNonHuman[0];
        return stryMutAct_9fa48("636") ? {} : (stryCov_9fa48("636"), {
          status: stryMutAct_9fa48("637") ? "" : (stryCov_9fa48("637"), 'found'),
          ticket_id: selected.id,
          priority: selected.frontmatter.priority,
          title: selected.frontmatter.title,
          type: selected.frontmatter.type,
          required_capabilities: JSON.stringify(stryMutAct_9fa48("640") ? selected.frontmatter.required_capabilities && [] : stryMutAct_9fa48("639") ? false : stryMutAct_9fa48("638") ? true : (stryCov_9fa48("638", "639", "640"), selected.frontmatter.required_capabilities || (stryMutAct_9fa48("641") ? ["Stryker was here"] : (stryCov_9fa48("641"), []))))
        });
      }
    }

    // Если есть созревшие human-тикеты — новый статус human_ready (для manual-gate)
    if (stryMutAct_9fa48("645") ? humanCandidates.length <= 0 : stryMutAct_9fa48("644") ? humanCandidates.length >= 0 : stryMutAct_9fa48("643") ? false : stryMutAct_9fa48("642") ? true : (stryCov_9fa48("642", "643", "644", "645"), humanCandidates.length > 0)) {
      if (stryMutAct_9fa48("646")) {
        {}
      } else {
        stryCov_9fa48("646");
        stryMutAct_9fa48("647") ? humanCandidates : (stryCov_9fa48("647"), humanCandidates.sort((a, b) => {
          if (stryMutAct_9fa48("648")) {
            {}
          } else {
            stryCov_9fa48("648");
            const priorityA = stryMutAct_9fa48("651") ? a.frontmatter.priority && 999 : stryMutAct_9fa48("650") ? false : stryMutAct_9fa48("649") ? true : (stryCov_9fa48("649", "650", "651"), a.frontmatter.priority || 999);
            const priorityB = stryMutAct_9fa48("654") ? b.frontmatter.priority && 999 : stryMutAct_9fa48("653") ? false : stryMutAct_9fa48("652") ? true : (stryCov_9fa48("652", "653", "654"), b.frontmatter.priority || 999);
            if (stryMutAct_9fa48("657") ? priorityA === priorityB : stryMutAct_9fa48("656") ? false : stryMutAct_9fa48("655") ? true : (stryCov_9fa48("655", "656", "657"), priorityA !== priorityB)) {
              if (stryMutAct_9fa48("658")) {
                {}
              } else {
                stryCov_9fa48("658");
                return stryMutAct_9fa48("659") ? priorityA + priorityB : (stryCov_9fa48("659"), priorityA - priorityB);
              }
            }
            const dateA = new Date(stryMutAct_9fa48("662") ? a.frontmatter.created_at && '9999-12-31' : stryMutAct_9fa48("661") ? false : stryMutAct_9fa48("660") ? true : (stryCov_9fa48("660", "661", "662"), a.frontmatter.created_at || (stryMutAct_9fa48("663") ? "" : (stryCov_9fa48("663"), '9999-12-31'))));
            const dateB = new Date(stryMutAct_9fa48("666") ? b.frontmatter.created_at && '9999-12-31' : stryMutAct_9fa48("665") ? false : stryMutAct_9fa48("664") ? true : (stryCov_9fa48("664", "665", "666"), b.frontmatter.created_at || (stryMutAct_9fa48("667") ? "" : (stryCov_9fa48("667"), '9999-12-31'))));
            return stryMutAct_9fa48("668") ? dateA + dateB : (stryCov_9fa48("668"), dateA - dateB);
          }
        }));
        const selected = humanCandidates[0];
        return stryMutAct_9fa48("669") ? {} : (stryCov_9fa48("669"), {
          status: stryMutAct_9fa48("670") ? "" : (stryCov_9fa48("670"), 'human_ready'),
          ticket_id: selected.id,
          priority: selected.frontmatter.priority,
          title: selected.frontmatter.title,
          pending_count: humanCandidates.length
        });
      }
    }
    return stryMutAct_9fa48("671") ? {} : (stryCov_9fa48("671"), {
      status: stryMutAct_9fa48("672") ? "" : (stryCov_9fa48("672"), 'empty'),
      reason: stryMutAct_9fa48("673") ? "" : (stryCov_9fa48("673"), 'No eligible non-human tickets (and no ready human tickets)')
    });
  }
}

/**
 * Архивирует все done-тикеты, принадлежащие архивным планам (plans/archive/).
 * Сканирует все планы в plans/archive/, находит их тикеты в done/ и перемещает в archive/.
 */
function archiveTicketsOfArchivedPlans() {
  if (stryMutAct_9fa48("674")) {
    {}
  } else {
    stryCov_9fa48("674");
    const archivedPlansDir = path.join(WORKFLOW_DIR, stryMutAct_9fa48("675") ? "" : (stryCov_9fa48("675"), 'plans'), stryMutAct_9fa48("676") ? "" : (stryCov_9fa48("676"), 'archive'));
    if (stryMutAct_9fa48("679") ? false : stryMutAct_9fa48("678") ? true : stryMutAct_9fa48("677") ? fs.existsSync(archivedPlansDir) : (stryCov_9fa48("677", "678", "679"), !fs.existsSync(archivedPlansDir))) return stryMutAct_9fa48("680") ? {} : (stryCov_9fa48("680"), {
      archived: stryMutAct_9fa48("681") ? ["Stryker was here"] : (stryCov_9fa48("681"), [])
    });

    // Собираем ID всех архивных планов
    const archivedPlanIds = new Set();
    const planFiles = stryMutAct_9fa48("682") ? fs.readdirSync(archivedPlansDir) : (stryCov_9fa48("682"), fs.readdirSync(archivedPlansDir).filter(stryMutAct_9fa48("683") ? () => undefined : (stryCov_9fa48("683"), f => stryMutAct_9fa48("684") ? f.startsWith('.md') : (stryCov_9fa48("684"), f.endsWith(stryMutAct_9fa48("685") ? "" : (stryCov_9fa48("685"), '.md'))))));
    for (const file of planFiles) {
      if (stryMutAct_9fa48("686")) {
        {}
      } else {
        stryCov_9fa48("686");
        const id = normalizePlanId(file);
        if (stryMutAct_9fa48("688") ? false : stryMutAct_9fa48("687") ? true : (stryCov_9fa48("687", "688"), id)) archivedPlanIds.add(id);
      }
    }
    if (stryMutAct_9fa48("691") ? archivedPlanIds.size !== 0 : stryMutAct_9fa48("690") ? false : stryMutAct_9fa48("689") ? true : (stryCov_9fa48("689", "690", "691"), archivedPlanIds.size === 0)) return stryMutAct_9fa48("692") ? {} : (stryCov_9fa48("692"), {
      archived: stryMutAct_9fa48("693") ? ["Stryker was here"] : (stryCov_9fa48("693"), [])
    });
    if (stryMutAct_9fa48("696") ? false : stryMutAct_9fa48("695") ? true : stryMutAct_9fa48("694") ? fs.existsSync(DONE_DIR) : (stryCov_9fa48("694", "695", "696"), !fs.existsSync(DONE_DIR))) return stryMutAct_9fa48("697") ? {} : (stryCov_9fa48("697"), {
      archived: stryMutAct_9fa48("698") ? ["Stryker was here"] : (stryCov_9fa48("698"), [])
    });
    if (stryMutAct_9fa48("701") ? false : stryMutAct_9fa48("700") ? true : stryMutAct_9fa48("699") ? fs.existsSync(ARCHIVE_DIR) : (stryCov_9fa48("699", "700", "701"), !fs.existsSync(ARCHIVE_DIR))) {
      if (stryMutAct_9fa48("702")) {
        {}
      } else {
        stryCov_9fa48("702");
        fs.mkdirSync(ARCHIVE_DIR, stryMutAct_9fa48("703") ? {} : (stryCov_9fa48("703"), {
          recursive: stryMutAct_9fa48("704") ? false : (stryCov_9fa48("704"), true)
        }));
      }
    }
    const archived = stryMutAct_9fa48("705") ? ["Stryker was here"] : (stryCov_9fa48("705"), []);
    const files = stryMutAct_9fa48("706") ? fs.readdirSync(DONE_DIR) : (stryCov_9fa48("706"), fs.readdirSync(DONE_DIR).filter(stryMutAct_9fa48("707") ? () => undefined : (stryCov_9fa48("707"), f => stryMutAct_9fa48("710") ? f.endsWith('.md') || f !== '.gitkeep.md' : stryMutAct_9fa48("709") ? false : stryMutAct_9fa48("708") ? true : (stryCov_9fa48("708", "709", "710"), (stryMutAct_9fa48("711") ? f.startsWith('.md') : (stryCov_9fa48("711"), f.endsWith(stryMutAct_9fa48("712") ? "" : (stryCov_9fa48("712"), '.md')))) && (stryMutAct_9fa48("714") ? f === '.gitkeep.md' : stryMutAct_9fa48("713") ? true : (stryCov_9fa48("713", "714"), f !== (stryMutAct_9fa48("715") ? "" : (stryCov_9fa48("715"), '.gitkeep.md'))))))));
    for (const file of files) {
      if (stryMutAct_9fa48("716")) {
        {}
      } else {
        stryCov_9fa48("716");
        const filePath = path.join(DONE_DIR, file);
        try {
          if (stryMutAct_9fa48("717")) {
            {}
          } else {
            stryCov_9fa48("717");
            const content = fs.readFileSync(filePath, stryMutAct_9fa48("718") ? "" : (stryCov_9fa48("718"), 'utf8'));
            const {
              frontmatter,
              body
            } = parseFrontmatter(content);
            const ticketPlanId = normalizePlanId(frontmatter.parent_plan);
            if (stryMutAct_9fa48("721") ? !ticketPlanId && !archivedPlanIds.has(ticketPlanId) : stryMutAct_9fa48("720") ? false : stryMutAct_9fa48("719") ? true : (stryCov_9fa48("719", "720", "721"), (stryMutAct_9fa48("722") ? ticketPlanId : (stryCov_9fa48("722"), !ticketPlanId)) || (stryMutAct_9fa48("723") ? archivedPlanIds.has(ticketPlanId) : (stryCov_9fa48("723"), !archivedPlanIds.has(ticketPlanId))))) continue;
            const ticketId = stryMutAct_9fa48("726") ? frontmatter.id && file.replace('.md', '') : stryMutAct_9fa48("725") ? false : stryMutAct_9fa48("724") ? true : (stryCov_9fa48("724", "725", "726"), frontmatter.id || file.replace(stryMutAct_9fa48("727") ? "" : (stryCov_9fa48("727"), '.md'), stryMutAct_9fa48("728") ? "Stryker was here!" : (stryCov_9fa48("728"), '')));
            frontmatter.updated_at = new Date().toISOString();
            frontmatter.archived_at = new Date().toISOString();
            const destPath = path.join(ARCHIVE_DIR, file);
            fs.writeFileSync(destPath, stryMutAct_9fa48("729") ? serializeFrontmatter(frontmatter) - body : (stryCov_9fa48("729"), serializeFrontmatter(frontmatter) + body), stryMutAct_9fa48("730") ? "" : (stryCov_9fa48("730"), 'utf8'));
            fs.unlinkSync(filePath);
            archived.push(ticketId);
            logger.info(stryMutAct_9fa48("731") ? `` : (stryCov_9fa48("731"), `[ARCHIVE] ${ticketId}: done → archive (plan ${ticketPlanId} is archived)`));
          }
        } catch (e) {
          if (stryMutAct_9fa48("732")) {
            {}
          } else {
            stryCov_9fa48("732");
            logger.warn(stryMutAct_9fa48("733") ? `` : (stryCov_9fa48("733"), `Failed to archive ticket ${file}: ${e.message}`));
          }
        }
      }
    }
    return stryMutAct_9fa48("734") ? {} : (stryCov_9fa48("734"), {
      archived
    });
  }
}

// Main entry point
async function main() {
  if (stryMutAct_9fa48("735")) {
    {}
  } else {
    stryCov_9fa48("735");
    const planId = extractPlanId();
    if (stryMutAct_9fa48("737") ? false : stryMutAct_9fa48("736") ? true : (stryCov_9fa48("736", "737"), planId)) {
      if (stryMutAct_9fa48("738")) {
        {}
      } else {
        stryCov_9fa48("738");
        logger.info(stryMutAct_9fa48("739") ? `` : (stryCov_9fa48("739"), `Filtering by plan_id: ${planId}`));
      }
    }
    const configPath = path.join(WORKFLOW_DIR, stryMutAct_9fa48("740") ? "" : (stryCov_9fa48("740"), 'config'), stryMutAct_9fa48("741") ? "" : (stryCov_9fa48("741"), 'ticket-movement-rules.yaml'));
    let movementConfig = null;
    try {
      if (stryMutAct_9fa48("742")) {
        {}
      } else {
        stryCov_9fa48("742");
        movementConfig = loadTicketMovementRules(configPath);
        logger.info(stryMutAct_9fa48("743") ? "" : (stryCov_9fa48("743"), 'Loaded ticket movement rules from config'));
      }
    } catch (e) {
      if (stryMutAct_9fa48("744")) {
        {}
      } else {
        stryCov_9fa48("744");
        logger.warn(stryMutAct_9fa48("745") ? `` : (stryCov_9fa48("745"), `Failed to load ticket movement config: ${e.message}`));
      }
    }
    logger.info(stryMutAct_9fa48("746") ? "" : (stryCov_9fa48("746"), 'Running auto-correction...'));
    const correctionResult = autoCorrectTickets(movementConfig);
    if (stryMutAct_9fa48("750") ? correctionResult.moved.length <= 0 : stryMutAct_9fa48("749") ? correctionResult.moved.length >= 0 : stryMutAct_9fa48("748") ? false : stryMutAct_9fa48("747") ? true : (stryCov_9fa48("747", "748", "749", "750"), correctionResult.moved.length > 0)) {
      if (stryMutAct_9fa48("751")) {
        {}
      } else {
        stryCov_9fa48("751");
        logger.info(stryMutAct_9fa48("752") ? `` : (stryCov_9fa48("752"), `Auto-corrected ${correctionResult.moved.length} ticket(s)`));
      }
    }

    // Архивируем done-тикеты архивных планов
    const archiveResult = archiveTicketsOfArchivedPlans();
    if (stryMutAct_9fa48("756") ? archiveResult.archived.length <= 0 : stryMutAct_9fa48("755") ? archiveResult.archived.length >= 0 : stryMutAct_9fa48("754") ? false : stryMutAct_9fa48("753") ? true : (stryCov_9fa48("753", "754", "755", "756"), archiveResult.archived.length > 0)) {
      if (stryMutAct_9fa48("757")) {
        {}
      } else {
        stryCov_9fa48("757");
        logger.info(stryMutAct_9fa48("758") ? `` : (stryCov_9fa48("758"), `Archived ${archiveResult.archived.length} ticket(s) from archived plans: ${archiveResult.archived.join(stryMutAct_9fa48("759") ? "" : (stryCov_9fa48("759"), ', '))}`));
      }
    }
    if (stryMutAct_9fa48("761") ? false : stryMutAct_9fa48("760") ? true : (stryCov_9fa48("760", "761"), planId)) {
      if (stryMutAct_9fa48("762")) {
        {}
      } else {
        stryCov_9fa48("762");
        const closeResult = checkAndClosePlan(WORKFLOW_DIR, planId);
        if (stryMutAct_9fa48("764") ? false : stryMutAct_9fa48("763") ? true : (stryCov_9fa48("763", "764"), closeResult.closed)) {
          if (stryMutAct_9fa48("765")) {
            {}
          } else {
            stryCov_9fa48("765");
            logger.info(stryMutAct_9fa48("766") ? `` : (stryCov_9fa48("766"), `Plan ${planId} closed: all ${closeResult.total} tickets done`));
          }
        } else if (stryMutAct_9fa48("770") ? closeResult.total <= 0 : stryMutAct_9fa48("769") ? closeResult.total >= 0 : stryMutAct_9fa48("768") ? false : stryMutAct_9fa48("767") ? true : (stryCov_9fa48("767", "768", "769", "770"), closeResult.total > 0)) {
          if (stryMutAct_9fa48("771")) {
            {}
          } else {
            stryCov_9fa48("771");
            logger.info(stryMutAct_9fa48("772") ? `` : (stryCov_9fa48("772"), `Plan ${planId} progress: ${closeResult.done}/${closeResult.total} tickets done`));
          }
        }
      }
    }
    logger.info(stryMutAct_9fa48("773") ? `` : (stryCov_9fa48("773"), `Scanning ready/ directory: ${READY_DIR}`));
    const result = pickNextTicket(planId);
    if (stryMutAct_9fa48("776") ? result.status !== 'found' : stryMutAct_9fa48("775") ? false : stryMutAct_9fa48("774") ? true : (stryCov_9fa48("774", "775", "776"), result.status === (stryMutAct_9fa48("777") ? "" : (stryCov_9fa48("777"), 'found')))) {
      if (stryMutAct_9fa48("778")) {
        {}
      } else {
        stryCov_9fa48("778");
        logger.info(stryMutAct_9fa48("779") ? `` : (stryCov_9fa48("779"), `Selected ticket: ${result.ticket_id} (${result.title})`));
        logger.info(stryMutAct_9fa48("780") ? `` : (stryCov_9fa48("780"), `Priority: ${result.priority}, Type: ${result.type}`));
      }
    } else {
      if (stryMutAct_9fa48("781")) {
        {}
      } else {
        stryCov_9fa48("781");
        logger.info(result.reason);
      }
    }
    logger.info(stryMutAct_9fa48("782") ? "" : (stryCov_9fa48("782"), 'Calculating review metrics...'));
    const reviewMetrics = calculateReviewMetrics();
    logger.info(stryMutAct_9fa48("783") ? `` : (stryCov_9fa48("783"), `Found ${reviewMetrics.tickets_with_reviews} tickets with reviews`));
    logger.info(stryMutAct_9fa48("784") ? `` : (stryCov_9fa48("784"), `Total failed: ${reviewMetrics.total_failed}, passed: ${reviewMetrics.total_passed}`));
    const metricsDir = path.join(WORKFLOW_DIR, stryMutAct_9fa48("785") ? "" : (stryCov_9fa48("785"), 'metrics'));
    if (stryMutAct_9fa48("788") ? false : stryMutAct_9fa48("787") ? true : stryMutAct_9fa48("786") ? fs.existsSync(metricsDir) : (stryCov_9fa48("786", "787", "788"), !fs.existsSync(metricsDir))) {
      if (stryMutAct_9fa48("789")) {
        {}
      } else {
        stryCov_9fa48("789");
        fs.mkdirSync(metricsDir, stryMutAct_9fa48("790") ? {} : (stryCov_9fa48("790"), {
          recursive: stryMutAct_9fa48("791") ? false : (stryCov_9fa48("791"), true)
        }));
      }
    }
    const metricsFile = path.join(metricsDir, stryMutAct_9fa48("792") ? "" : (stryCov_9fa48("792"), 'review-metrics.json'));
    fs.writeFileSync(metricsFile, JSON.stringify(reviewMetrics, null, 2), stryMutAct_9fa48("793") ? "" : (stryCov_9fa48("793"), 'utf8'));
    logger.info(stryMutAct_9fa48("794") ? `` : (stryCov_9fa48("794"), `Metrics saved to ${metricsFile}`));
    const finalResult = stryMutAct_9fa48("795") ? {} : (stryCov_9fa48("795"), {
      ...result,
      auto_corrected: correctionResult.moved.length,
      moved_tickets: correctionResult.moved.map(stryMutAct_9fa48("796") ? () => undefined : (stryCov_9fa48("796"), m => m.id)).join(stryMutAct_9fa48("797") ? "" : (stryCov_9fa48("797"), ',')),
      review_metrics: JSON.stringify(reviewMetrics)
    });
    printResult(finalResult);
    if (stryMutAct_9fa48("800") ? result.status !== 'empty' : stryMutAct_9fa48("799") ? false : stryMutAct_9fa48("798") ? true : (stryCov_9fa48("798", "799", "800"), result.status === (stryMutAct_9fa48("801") ? "" : (stryCov_9fa48("801"), 'empty')))) {
      if (stryMutAct_9fa48("802")) {
        {}
      } else {
        stryCov_9fa48("802");
        process.exit(0);
      }
    }
  }
}
main().catch(e => {
  if (stryMutAct_9fa48("803")) {
    {}
  } else {
    stryCov_9fa48("803");
    logger.error(e.message);
    printResult(stryMutAct_9fa48("804") ? {} : (stryCov_9fa48("804"), {
      status: stryMutAct_9fa48("805") ? "" : (stryCov_9fa48("805"), 'error'),
      error: e.message
    }));
    process.exit(1);
  }
});