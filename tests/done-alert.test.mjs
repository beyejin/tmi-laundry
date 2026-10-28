import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST_ALERT_DELAY_MS,
  alertDelay,
  cancelMessage,
  doneMessage,
  minutesUntil,
  readAlerts,
  scheduleLabel,
  scheduledLabel,
  showDoneNotification,
  subjectParticle,
  writeAlerts,
} from '../app/proto/done-alert.ts';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

test('세탁기 1 종료 알림 문장은 조심스러운 해요체예요', () => {
  assert.equal(subjectParticle('세탁기 1'), '이');
  assert.equal(subjectParticle('건조기 1'), '이');
  assert.equal(subjectParticle('세탁기 2'), '가');
  assert.equal(doneMessage('3생활관 여자 2층', '세탁기 1'), '3생활관 여자 2층 세탁기 1이 끝났을 거예요');
  assert.equal(doneMessage('3생활관 여자 2층', '세탁기 2'), '3생활관 여자 2층 세탁기 2가 끝났을 거예요');
  assert.equal(scheduleLabel, '끝나면 알려 주세요');
  assert.equal(cancelMessage, '알림을 취소했어요');
  assert.equal(scheduledLabel(28), '알림 예약됨 · 약 28분 뒤');
});

test('남은 분은 올림하고 1분보다 작아지지 않아요', () => {
  const now = 1_000_000;
  assert.equal(minutesUntil(now + 28 * 60_000, now), 28);
  assert.equal(minutesUntil(now + 60_001, now), 2);
  assert.equal(minutesUntil(now + 1_000, now), 1);
  assert.equal(minutesUntil(now - 5_000, now), 1);
});

test('빠른 확인은 10초 뒤, 그 외에는 예상 종료 시각까지 기다려요', () => {
  const now = 5_000;
  const endsAt = now + 36 * 60_000;
  assert.equal(alertDelay(endsAt, now, false), 36 * 60_000);
  assert.equal(alertDelay(endsAt, now, true), FAST_ALERT_DELAY_MS);
  assert.equal(FAST_ALERT_DELAY_MS, 10_000);
  assert.equal(alertDelay(now - 1, now, false), 0);
});

test('알림 예약은 localStorage 형태로 저장하고 잘못된 값은 버려요', () => {
  const storage = memoryStorage();
  assert.deepEqual(readAlerts(storage), {});
  const record = {
    machineId: 'h3-women-2-washer-1',
    endsAt: 2_000,
    fireAt: 1_500,
    fast: false,
    message: '3생활관 여자 2층 세탁기 1이 끝났을 거예요',
  };
  writeAlerts(storage, { [record.machineId]: record });
  assert.deepEqual(readAlerts(storage), { [record.machineId]: record });
  storage.setItem('tmi-laundry-done-alerts', JSON.stringify({
    bad: { machineId: 'other', endsAt: 1, fireAt: 1, fast: true, message: '아니에요' },
    broken: { nope: true },
  }));
  assert.deepEqual(readAlerts(storage), {});
  storage.setItem('tmi-laundry-done-alerts', '{');
  assert.deepEqual(readAlerts(storage), {});
  writeAlerts(storage, {});
  assert.equal(storage.getItem('tmi-laundry-done-alerts'), null);
});

test('브라우저 알림은 허용됐을 때만 같은 문장으로 만들어요', () => {
  const previous = globalThis.Notification;
  const calls = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) {
      calls.push({ title, options });
    }
  }
  globalThis.Notification = FakeNotification;
  showDoneNotification('3생활관 여자 2층 세탁기 1이 끝났을 거예요');
  FakeNotification.permission = 'denied';
  showDoneNotification('3생활관 여자 2층 세탁기 1이 끝났을 거예요');
  globalThis.Notification = previous;
  assert.deepEqual(calls, [{
    title: '3생활관 여자 2층 세탁기 1이 끝났을 거예요',
    options: { lang: 'ko' },
  }]);
});
