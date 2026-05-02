// k6 smoke test — stub for Sprint 0 CI wiring.
// Full SLO load tests land after Sprint 1 (see SPEC.md §Tests Plan / Load).
//
// Target SLOs (from SPEC.md §SLOs):
//   POST /api/bookings: p95 < 800ms, p99 < 1.5s
//   Public booking page render: p95 < 200ms at 50 rps on 2-vCPU
//
// Usage: k6 run tests/load/smoke.js

import { check, sleep } from "k6";
import http from "k6/http";

export const options = {
  duration: "5s",
  vus: 1,
  thresholds: {
    http_req_failed: ["rate<1.0"], // stub: tolerate all failures until app is real
  },
};

export default function () {
  const res = http.get("http://localhost:3000/");
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
  sleep(1);
}
