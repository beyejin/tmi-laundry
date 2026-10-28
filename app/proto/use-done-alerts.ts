"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  alertDelay,
  cancelMessage,
  doneMessage,
  notificationPermission,
  readAlerts,
  showDoneNotification,
  writeAlerts,
  type DoneAlertRecord,
} from "./done-alert";

type MachineTime = { id: string; endsAt: number | null };

export function useDoneAlerts({
  enabled,
  fast,
  loaded,
  machines,
  currentTime,
  onToast,
}: {
  enabled: boolean;
  fast: boolean;
  loaded: boolean;
  machines: MachineTime[];
  currentTime: number;
  onToast: (message: string) => void;
}) {
  const [alerts, setAlerts] = useState<Record<string, DoneAlertRecord>>({});
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [pending, setPending] = useState(false);
  const alertsRef = useRef(alerts);
  const timersRef = useRef<Map<string, number>>(new Map());
  const onToastRef = useRef(onToast);
  const currentTimeRef = useRef(currentTime);
  const schedulingRef = useRef(false);
  alertsRef.current = alerts;
  onToastRef.current = onToast;
  currentTimeRef.current = currentTime;

  const persist = useCallback((next: Record<string, DoneAlertRecord>) => {
    alertsRef.current = next;
    setAlerts(next);
    try {
      writeAlerts(window.localStorage, next);
    } catch {
      // 저장이 막혀도 이 방문의 예약은 메모리에서 유지해요.
    }
  }, []);

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle === undefined) return;
    window.clearTimeout(handle);
    timersRef.current.delete(id);
  }, []);

  const fire = useCallback((machineId: string) => {
    const record = alertsRef.current[machineId];
    if (!record) return;
    const next = { ...alertsRef.current };
    delete next[machineId];
    persist(next);
    clearTimer(machineId);
    showDoneNotification(record.message);
    onToastRef.current(record.message);
  }, [clearTimer, persist]);

  const arm = useCallback((record: DoneAlertRecord) => {
    clearTimer(record.machineId);
    const delay = Math.max(0, record.fireAt - Date.now());
    const handle = window.setTimeout(() => fire(record.machineId), delay);
    timersRef.current.set(record.machineId, handle);
  }, [clearTimer, fire]);

  useEffect(() => {
    try {
      setAlerts(readAlerts(window.localStorage));
    } catch {
      setAlerts({});
    }
    setPermission(notificationPermission());
  }, []);

  useEffect(() => {
    for (const id of [...timersRef.current.keys()]) clearTimer(id);
    if (!enabled) return;
    for (const record of Object.values(alerts)) arm(record);
    return () => {
      for (const id of [...timersRef.current.keys()]) clearTimer(id);
    };
  }, [alerts, enabled, arm, clearTimer]);

  useEffect(() => {
    if (!enabled || !loaded || Object.keys(alertsRef.current).length === 0) return;
    let changed = false;
    const next = { ...alertsRef.current };
    for (const record of Object.values(alertsRef.current)) {
      const machine = machines.find((item) => item.id === record.machineId);
      if (!machine || machine.endsAt === null) {
        delete next[record.machineId];
        changed = true;
        continue;
      }
      if (!record.fast && machine.endsAt !== record.endsAt) {
        next[record.machineId] = {
          ...record,
          endsAt: machine.endsAt,
          fireAt: Date.now() + alertDelay(machine.endsAt, currentTime, false),
        };
        changed = true;
      }
    }
    if (changed) persist(next);
  }, [enabled, loaded, machines, currentTime, persist]);

  async function schedule(input: { machineId: string; endsAt: number; locationLabel: string; machineName: string }) {
    if (schedulingRef.current || alertsRef.current[input.machineId]) return;
    schedulingRef.current = true;
    setPending(true);
    try {
      let nextPermission = notificationPermission();
      if (nextPermission === "default" && typeof Notification !== "undefined") {
        try {
          nextPermission = await Notification.requestPermission();
        } catch {
          nextPermission = "denied";
        }
      }
      setPermission(nextPermission);
      const record: DoneAlertRecord = {
        machineId: input.machineId,
        endsAt: input.endsAt,
        fireAt: Date.now() + alertDelay(input.endsAt, currentTimeRef.current, fast),
        fast,
        message: doneMessage(input.locationLabel, input.machineName),
      };
      persist({ ...alertsRef.current, [record.machineId]: record });
    } finally {
      schedulingRef.current = false;
      setPending(false);
    }
  }

  function cancel(machineId: string) {
    if (!alertsRef.current[machineId]) return;
    const next = { ...alertsRef.current };
    delete next[machineId];
    persist(next);
    onToastRef.current(cancelMessage);
  }

  return { alerts, permission, pending, schedule, cancel };
}
