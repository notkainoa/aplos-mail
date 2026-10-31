"""Oracle A: python-dateutil's rrule/rruleset with zoneinfo time zones.

Reads a JSON list of jobs on stdin and writes one JSON result per job on stdout. Each job is a
series (start, end, allDay, tzid, rrule, rdate, exdate, overrides) plus a cutoff; the result is the
series' recurrence set (original starts, as occurrence keys) up to the cutoff, the duration, and the
overrides' times as keys. Applying overrides and the range is left to the merge step, so both oracles
feed it the same way.

Run it from the throwaway venv only (python-dateutil is never a dependency of the repo):
  /tmp/aplos-rrule-oracle/bin/python -I oracle_a.py < jobs.json
"""

import json
import re
import sys
import warnings
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import dateutil
from dateutil.rrule import rrulestr, rruleset

UTC = timezone.utc
CAP = 20000
VALUE = re.compile(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$")


class Refused(Exception):
    pass


def compact(text):
    """'2026-03-01T09:00:00' -> '20260301T090000'."""
    return text.replace("-", "").replace(":", "")


class Series:
    def __init__(self, job):
        self.all_day = job["allDay"]
        start = job["start"]
        tzid = start.get("tzid") or job.get("tzid")
        if self.all_day:
            self.mode = "date"
            self.zone = None
        elif "utc" in start or tzid:
            self.mode = "zoned"
            self.zone = ZoneInfo(tzid or "UTC")
        else:
            self.mode = "floating"
            self.zone = None
        self.dtstart = self.event_time(start)
        end = self.event_time(job["end"])
        if self.mode == "zoned":
            # Aware datetimes in one zone subtract as wall clocks; go through UTC for the exact duration.
            self.duration = end.astimezone(UTC) - self.dtstart.astimezone(UTC)
        else:
            self.duration = end - self.dtstart

    def event_time(self, t):
        if "utc" in t:
            dt = datetime.fromtimestamp(t["utc"] / 1000, UTC)
            return dt.astimezone(self.zone) if self.mode == "zoned" else dt.replace(tzinfo=None)
        if "date" in t:
            y, m, d = (int(x) for x in t["date"].split("-"))
            return datetime(y, m, d)
        return self.value(compact(t["local"]), t.get("tzid"))

    def value(self, text, tzid=None):
        """An iCalendar DATE or DATE-TIME as a datetime comparable with this series' instances."""
        m = VALUE.match(text)
        if not m:
            raise Refused("bad date value " + text)
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
        if m[4] is None:
            if self.mode == "date":
                return datetime(y, mo, d)
            # A DATE on a timed series names that day at the series' own time.
            return self.dtstart.replace(year=y, month=mo, day=d)
        h, mi, s = int(m[4]), int(m[5]), int(m[6])
        if self.mode == "date":
            return datetime(y, mo, d)
        if self.mode == "floating":
            return datetime(y, mo, d, h, mi, s)
        if m[7]:
            return datetime(y, mo, d, h, mi, s, tzinfo=UTC)
        return datetime(y, mo, d, h, mi, s, tzinfo=ZoneInfo(tzid) if tzid else self.zone)

    def key(self, dt):
        if self.mode == "date":
            return dt.strftime("%Y%m%d")
        if self.mode == "floating":
            return dt.strftime("%Y%m%dT%H%M%S")
        return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")

    def key_of(self, t):
        """Key of an override time (any EventTime kind), by its own kind."""
        if "date" in t:
            return compact(t["date"])
        if "utc" in t:
            return datetime.fromtimestamp(t["utc"] / 1000, UTC).strftime("%Y%m%dT%H%M%SZ")
        tzid = t.get("tzid") or (self.zone.key if self.mode == "zoned" else None)
        if tzid:
            m = VALUE.match(compact(t["local"]))
            dt = datetime(*(int(m[i]) for i in range(1, 7)), tzinfo=ZoneInfo(tzid))
            return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
        return compact(t["local"])

    def recurrence_id(self, rid):
        if isinstance(rid, str):
            return self.key(self.value(rid))
        if "date" in rid:
            return self.key(self.value(compact(rid["date"])))
        if "utc" in rid:
            return self.key(datetime.fromtimestamp(rid["utc"] / 1000, UTC))
        return self.key(self.value(compact(rid["local"]), rid.get("tzid")))

    def comparable_ms(self, dt):
        if self.mode == "zoned":
            return int(dt.astimezone(UTC).timestamp() * 1000)
        return int(dt.replace(tzinfo=UTC).timestamp() * 1000)


def date_lines(lines):
    """('TZID or None', ['value', ...]) per RDATE/EXDATE line or bare value list."""
    out = []
    for line in lines or []:
        m = re.match(r"^([A-Za-z-]+(?:;[^:]*)?):(.*)$", line)
        tzid = None
        values = line
        if m:
            for param in m[1].split(";")[1:]:
                k, _, v = param.partition("=")
                if k.upper() == "TZID":
                    tzid = v.strip('"')
            values = m[2]
        out.append((tzid, [v for v in values.split(",") if v]))
    return out


def run(job):
    series = Series(job)
    rset = rruleset()
    if job.get("rrule"):
        text = re.sub(r"^RRULE:", "", job["rrule"], flags=re.I)
        with warnings.catch_warnings():
            # dateutil only warns about COUNT with UNTIL; RFC 5545 says MUST NOT, so treat it as a refusal.
            warnings.simplefilter("error")
            rule = rrulestr(text, dtstart=series.dtstart)
            # Touch the rule once so lazy validation errors surface here.
            next(iter(rule), None)
        rset.rrule(rule)
    else:
        rset.rdate(series.dtstart)
    for tzid, values in date_lines(job.get("rdate")):
        for v in values:
            rset.rdate(series.value(v, tzid))
    for tzid, values in date_lines(job.get("exdate")):
        for v in values:
            rset.exdate(series.value(v, tzid))

    keys = []
    seen = set()
    for dt in rset:
        if series.comparable_ms(dt) > job["cutoff"] or len(keys) >= CAP:
            break
        k = series.key(dt)
        if k not in seen:
            seen.add(k)
            keys.append(k)
    overrides = []
    for o in job.get("overrides") or []:
        overrides.append({
            "recurrenceId": series.recurrence_id(o["recurrenceId"]),
            "start": series.key_of(o["start"]) if o.get("start") else None,
            "end": series.key_of(o["end"]) if o.get("end") else None,
            "cancelled": bool(o.get("cancelled")),
        })
    return {
        "status": "ok",
        "mode": series.mode,
        "durationMs": int(series.duration / timedelta(milliseconds=1)),
        "instances": keys,
        "overrides": overrides,
    }


def main():
    jobs = json.load(sys.stdin)
    results = []
    for job in jobs:
        try:
            results.append({"id": job["id"], **run(job)})
        except Exception as err:  # every failure is a refusal of that case, reported with its reason
            results.append({"id": job["id"], "status": "refused", "error": f"{type(err).__name__}: {err}"})
    json.dump({"oracle": "A", "engine": f"python-dateutil {dateutil.__version__}, zoneinfo", "results": results}, sys.stdout)


if __name__ == "__main__":
    main()
