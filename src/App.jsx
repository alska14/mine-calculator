import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, db, googleProvider } from "./firebase";

/**
 * =========
 * Utilities
 * =========
 */


function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ko-KR");
}
function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
function netSell(gross, feeRate) {
  return gross * (1 - feeRate);
}
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function getClientId() {
  try {
    const key = "miner_feedback_client_id";
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const next = `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(key, next);
    return next;
  } catch {
    return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

/**
 * Numeric input guard
 * - preserve string state while typing
 * - cast numbers only during calculation
 */
function toNum(v, fallback = 0) {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v !== "string") return fallback;
  const t = v.trim();
  if (!t) return fallback;
  if (t === "-" || t === "." || t === "-.") return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Deep merge for localStorage state migration
 */
function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function migrateState(raw, defaults) {
  const incoming = isPlainObject(raw) ? raw : {};
  const incomingVer = Number.isFinite(incoming.schemaVersion) ? incoming.schemaVersion : 0;

  let s = deepMerge(defaults, incoming);

  // v0 -> v1 : potionRowDetailsOpen
  if (incomingVer < 1) {
    s = {
      ...s,
      potionRowDetailsOpen: {
        p100: false,
        p300: false,
        p500: false,
        p700: false,
        ...(s.potionRowDetailsOpen || {}),
      },
    };
  }

  // v1 -> v2: normalize price shape
  if (incomingVer < 2) {
    const oldPrices = s.prices || {};
    const normalized = {};
    for (const [k, v] of Object.entries(oldPrices)) {
      // prefer market, then grossSell, then buy
      if (isPlainObject(v)) {
        const market = v.market ?? v.grossSell ?? v.buy ?? 0;
        normalized[k] = { market: String(market ?? "") };
      } else {
        normalized[k] = { market: String(v ?? "") };
      }
    }
    s = { ...s, prices: deepMerge(defaults.prices, normalized) };
  }

  // v2 -> v3: feedback defaults
  if (incomingVer < 3) {
    s = {
      ...s,
      feedbacks: {
        nextId: 1,
        items: [],
        ...(s.feedbacks || {}),
      },
    };
  }

  // v3 -> v4: adminMode default
  if (incomingVer < 4) {
    s = {
      ...s,
      adminMode: false,
    };
  }

  s.schemaVersion = defaults.schemaVersion;
  return s;
}

function useLocalStorageState(key, initialValue) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return initialValue;
      const parsed = JSON.parse(raw);
      return migrateState(parsed, initialValue);
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [key, state]);

  return [state, setState];
}

/**
 * =========
 * UI pieces
 * =========
 */
function Card({ title, children }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 14, background: "var(--card-bg)" }}>
      <div style={{ fontWeight: 900, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, min, max, suffix, placeholder }) {
  const display = value === null || value === undefined ? "" : String(value);

  const sanitizeOnBlur = () => {
    const n = toNum(value, NaN);
    if (!Number.isFinite(n)) {
      onChange(""); // 鍮덇컪 ?좎?
      return;
    }
    let v = n;
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    onChange(String(v));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          inputMode="decimal"
          value={display}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={sanitizeOnBlur}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid var(--input-border)",
            outline: "none",
            fontSize: 14,
            background: "var(--input-bg)",
            color: "var(--text)",
          }}
        />
        {suffix ? <div style={{ fontSize: 13, opacity: 0.75, minWidth: 40 }}>{suffix}</div> : null}
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = "text" }) {
  const display = value === null || value === undefined ? "" : String(value);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
      <input
        type={type}
        value={display}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--input-border)",
          outline: "none",
          fontSize: 14,
          background: "var(--input-bg)",
          color: "var(--text)",
        }}
      />
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 4 }) {
  const display = value === null || value === undefined ? "" : String(value);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
      <textarea
        value={display}
        placeholder={placeholder}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--input-border)",
          outline: "none",
          fontSize: 14,
          background: "var(--input-bg)",
          color: "var(--text)",
          resize: "vertical",
        }}
      />
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  const handleChange = (e) => {
    const raw = e.target.value;
    const num = Number(raw);
    const next = Number.isFinite(num) && String(num) === raw ? num : raw;
    onChange(next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
      <select
        value={value}
        onChange={handleChange}
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--input-border)",
          outline: "none",
          fontSize: 14,
          background: "var(--input-bg)",
          color: "var(--text)",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleButton({ isOn, onClick, labelOn, labelOff }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--input-border)",
        background: "var(--input-bg)",
        color: "var(--text)",
        cursor: "pointer",
        fontWeight: 900,
        fontSize: 13,
      }}
    >
      {isOn ? labelOn : labelOff}
    </button>
  );
}

/**
 * =========================
 * Domain rules (user inputs)
 * =========================
 */

// SAGE pick upgrade shards per level
const SAGE_SHARDS_BY_ENH = {
  5: 4,
  6: 4,
  7: 4,
  8: 5,
  9: 5,
  10: 5,
  11: 6,
  12: 6,
  13: 7,
  14: 7,
  15: 12,
};

// gem expert rule by level
function gemExpertRule(level) {
  if (level === 1) return { prob: 0.03, count: 1 };
  if (level === 2) return { prob: 0.07, count: 1 };
  if (level === 3) return { prob: 0.10, count: 2 };
  return { prob: 0, count: 0 };
}

// flaming pick rule by level (prob, ingots)
// 1~9?덈꺼: 1~9% / 10?덈꺼: 15%
function flamingPickRule(level) {
  if (!Number.isFinite(level) || level <= 0) return { prob: 0, ingots: 1 };
  if (level >= 10) return { prob: 0.15, ingots: 1 };
  return { prob: level / 100, ingots: 1 };
}

/**
 * ======================
 * Expected value function
 * ======================
 * ?듭떖 洹쒖튃(?뺤젙):
 * - 遺덈텤? 怨↔눌?닿? 諛쒕룞?섎㈃: 議곌컖 0媛?+ 二쇨눼 1媛??泥?
 * - keep gem expert ordering same as flaming pick values
 */
function miningEVBreakdown({
  staminaPerDig,
  shardsPerDig,
  shardsPerIngot,
  ingotGrossPrice,
  gemDropProb,
  gemDropCount,
  gemGrossPrice,
  flamingIngotProb,
  sellFeeRate,
}) {
  const spd = Math.max(1, staminaPerDig);
  const spi = Math.max(1, shardsPerIngot);

  const p = clamp01(flamingIngotProb);

  const ingotNet = netSell(Math.max(0, ingotGrossPrice), sellFeeRate);
  const gemNet = netSell(Math.max(0, gemGrossPrice), sellFeeRate);

  // ??遺덈텤?? "異붽?"媛 ?꾨땲??"?泥?
  const ingotFromShardsPerDig = (1 - p) * (Math.max(0, shardsPerDig) / spi);
  const ingotFromShardsValuePerDig = ingotFromShardsPerDig * ingotNet;

  const ingotFromFlamePerDig = p * 1;
  const ingotFromFlameValuePerDig = ingotFromFlamePerDig * ingotNet;

  // 蹂댁꽍? 遺덈텤? ?щ?? 臾닿??섍쾶 洹몃?濡??먯젙
  const gemValuePerDig = clamp01(gemDropProb) * Math.max(0, gemDropCount) * gemNet;

  const totalPerDig = ingotFromShardsValuePerDig + ingotFromFlameValuePerDig + gemValuePerDig;
  const totalPerStamina = totalPerDig / spd;

  return {
    pFlame: p,
    staminaPerDig: spd,
    shardsPerIngot: spi,
    ingotNet,
    gemNet,
    ingotFromShardsPerDig,
    ingotFromShardsValuePerDig,
    ingotFromFlamePerDig,
    ingotFromFlameValuePerDig,
    gemValuePerDig,
    totalPerDig,
    totalPerStamina,
  };
}

/**
 * ======================
 * Crafting profit helpers
 * ======================
 * 蹂寃쎌젏(以묒슂):
 * - ?щ즺 媛寃⑹? market 1媛쒕쭔 ?낅젰
 * - purchase cost uses market value (no fee)
 * - 援щℓ 鍮꾩슜? market 洹몃?濡??섏닔猷??놁쓬)
 */
function unitCostByMode({ mode, marketPrice, feeRate }) {
  if (mode === "owned") return 0;
  if (mode === "buy") return Math.max(0, marketPrice); // gem expert rule by level
  // gem expert rule by level: level -> prob/count
}

function craftProfit({ productGrossSellPrice, feeRate, costs }) {
  const revenue = netSell(Math.max(0, productGrossSellPrice), feeRate);
  const totalCost = costs.reduce((acc, c) => acc + (c.unitCost || 0) * (c.qty || 0), 0);
  return { revenue, totalCost, profit: revenue - totalCost };
}

/**
 * ==========
 * App state
 * ==========
 */
const defaultState = {
  schemaVersion: 4,

  activeMenu: "potion", // potion | ingot | profile | feedback | village | members
  feePct: "5",
  themeMode: "light", // light | dark

  // ?댁젙蹂?  sageEnhLevel: 15, // 5~15
  gemExpertLevel: 3, // 0~3
  flamingPickLevel: 0, // 0~10
  staminaPerDig: "10",
  shardsPerIngot: "16",

  // gem expert rule by level
  ingotGrossPrice: "6000",
  gemGrossPrice: "12000",

  // ?ъ뀡 媛寃?援щℓ媛)
  potionPrices: {
    p100: "14000",
    p300: "70000",
    p500: "160000",
    p700: "210000",
  },

  // ?ъ뀡 寃곌낵 ?됰퀎 ?몃??댁뿭 ?ㅽ뵂 ?곹깭
  potionRowDetailsOpen: {
    p100: false,
    p300: false,
    p500: false,
    p700: false,
  },

  // gem expert rule by level
  abilityGrossSell: "18000",
  lifeGrossSell: {
    low: "9000", // ?섍툒
    mid: "30000", // 以묎툒
    high: "60000", // ?곴툒
  },

  // gem expert rule by level
  prices: {
    ingot: { market: "6000" },
    stone: { market: "773" }, // ?뚮춬移??섍툒)
    deepCobble: { market: "281" }, // gem expert rule by level
    redstone: { market: "97" },
    copper: { market: "100" },
    diamond: { market: "2900" },
    iron: { market: "700" },
    lapis: { market: "100" },
    gold: { market: "570" },
    amethyst: { market: "78" },
  },

  // gem expert rule by level
  modes: {
    ingot: "opportunity",
    stone: "owned",
    deepCobble: "owned",
    redstone: "owned",
    copper: "owned",
    diamond: "buy",
    iron: "owned",
    lapis: "owned",
    gold: "owned",
    amethyst: "owned",
  },

  // ?덉떆??湲곕낯媛?
  recipes: {
    ability: { ingot: 3 },
    low: { ingot: 1, stone: 2, redstone: 3, copper: 8 },
    mid: { ingot: 2, deepCobble: 2, diamond: 3, iron: 5, lapis: 5 },
    high: { ingot: 3, diamond: 5, gold: 7, iron: 7, amethyst: 20, copper: 30 },
  },

  feedbacks: {
    nextId: 1,
    items: [],
  },

  adminMode: false,
};

function Sidebar({ active, onSelect, onlineUsers, birthdayMap, calendarInfo, onPrevMonth, onNextMonth }) {
  const itemStyle = (key) => ({
    padding: "10px 12px",
    borderRadius: 10,
    border: active === key ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: active === key ? "var(--accent)" : "var(--panel-bg)",
    color: active === key ? "var(--accent-text)" : "var(--text)",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 13,
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 6 }}>메뉴</div>
      <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
        {"\ub2e4\ud06c\ubaa8\ub4dc\ub294 \ub0b4\uc815\ubcf4\uc5d0\uc11c \uc124\uc815\ud560 \uc218 \uc788\uace0, \ubb38\uc81c\uc810\uc740 \ubb38\uc758/\ud53c\ub4dc\ubc31\uc5d0 \ub0a8\uaca8\uc8fc\uc138\uc694."}
      </div>
      <div style={itemStyle("potion")} onClick={() => onSelect("potion")}>스테미나 포션 효율 계산</div>
      <div style={itemStyle("ingot")} onClick={() => onSelect("ingot")}>주괴/가공 비교</div>
      <div style={itemStyle("profile")} onClick={() => onSelect("profile")}>내정보 + 시세 입력</div>
      <div style={itemStyle("feedback")} onClick={() => onSelect("feedback")}>문의/피드백</div>
      <div style={itemStyle("village")} onClick={() => onSelect("village")}>마을 건의함</div>
      <div style={itemStyle("members")} onClick={() => onSelect("members")}>마을 멤버</div>
      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.75, lineHeight: 1.4 }}>
        입력값은 브라우저에 자동 저장됩니다.
      </div>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--soft-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 900 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#2ecc71",
              boxShadow: "0 0 6px rgba(46, 204, 113, 0.8)",
              display: "inline-block",
            }}
          />
          {`온라인 ${onlineUsers.length}명`}
        </div>
        {onlineUsers.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>접속 중인 사용자가 없습니다.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {onlineUsers.map((user) => (
              <div key={user.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2ecc71", display: "inline-block" }} />
                <span>{user.nickname || user.displayName || user.email || "익명"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {calendarInfo ? (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--soft-border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <button
              onClick={onPrevMonth}
              style={{
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--input-border)",
                background: "var(--panel-bg)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {"?댁쟾"}
            </button>
            <div style={{ fontSize: 12, fontWeight: 900 }}>{`${calendarInfo.year}년 ${calendarInfo.month}월 생일`}</div>
            <button
              onClick={onNextMonth}
              style={{
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--input-border)",
                background: "var(--panel-bg)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {"?ㅼ쓬"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
            {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
              <div key={d} style={{ fontSize: 10, fontWeight: 900, textAlign: "center", opacity: 0.7 }}>
                {d}
              </div>
            ))}
            {calendarInfo.cells.map((day, idx) => {
              if (!day) {
                return <div key={`empty-${idx}`} style={{ minHeight: 26 }} />;
              }
              const monthKey = String(calendarInfo.month).padStart(2, "0");
              const dayKey = String(day).padStart(2, "0");
              const key = `${monthKey}-${dayKey}`;
              const list = birthdayMap?.[key] || [];
              const title = list.length ? list.map((p) => p.nickname || p.mcNickname || "이름 없음").join(", ") : "";
              return (
                <div
                  key={`day-${day}`}
                  title={title}
                  style={{
                    minHeight: 26,
                    borderRadius: 8,
                    border: "1px solid var(--soft-border)",
                    padding: 4,
                    fontSize: 10,
                    background: list.length ? "rgba(46, 204, 113, 0.08)" : "transparent",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>{day}</div>
                  {list.length ? (
                    <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#2ecc71", display: "inline-block" }} />
                      <span style={{ fontSize: 10 }}>{list.length}</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * =======================
 * Pages
 * =======================
 */

function FeedbackPage({ s, setS }) {
  const [form, setForm] = useState({
    type: "improve",
    title: "",
    body: "",
    contact: "",
    visibility: "public",
  });
  const [customType, setCustomType] = useState("");

  const [items, setItems] = useState([]);
  const [replyDrafts, setReplyDrafts] = useState({});
  const isAdmin = s.adminMode === true;
  const canSubmit = form.title.trim() && form.body.trim();
  const [clientId] = useState(() => getClientId());

  useEffect(() => {
    const q = query(collection(db, "feedbacks"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const visible = isAdmin
        ? rows
        : rows.filter((r) => r.visibility !== "private" || r.authorId === clientId);
      setItems(visible);
    });
    return () => unsub();
  }, [isAdmin, clientId]);

  useEffect(() => {
    setReplyDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      items.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = item.reply || "";
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [items]);

  const submit = () => {
    if (!canSubmit) return;
    addDoc(collection(db, "feedbacks"), {
      type: form.type,
      title: form.title.trim(),
      body: form.body.trim(),
      contact: form.contact.trim(),
      visibility: form.visibility,
      authorId: clientId,
      status: "new",
      createdAt: serverTimestamp(),
    });
    setForm({ type: "improve", title: "", body: "", contact: "", visibility: "public" });
  };

  const updateStatus = (id, status) => {
    if (!isAdmin) return;
    updateDoc(doc(db, "feedbacks", id), { status });
  };

  const removeItem = (id) => {
    if (!isAdmin) return;
    deleteDoc(doc(db, "feedbacks", id));
  };

  const saveReply = (id, reply) => {
    if (!isAdmin) return;
    const trimmed = (reply || "").trim();
    updateDoc(doc(db, "feedbacks", id), {
      reply: trimmed,
      repliedAt: trimmed ? serverTimestamp() : null,
      status: trimmed ? "done" : "progress",
    });
  };

  const typeLabel = (type) => {
    if (type === "bug") return "오류/잘못된 점";
    if (type === "other") return "기타";
    return "개선";
  };

  const statusLabel = (status) => {
    if (status === "progress") return "진행중";
    if (status === "done") return "완료";
    return "접수";
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="개선점/오류 제보">
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
          사용 중 문제점이나 개선 아이디어가 있으면 문의/피드백에 남겨주세요.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>유형</div>
            <select
              value={form.type}
              onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--input-border)",
                outline: "none",
                fontSize: 14,
                background: "var(--input-bg)",
                color: "var(--text)",
              }}
            >
              <option value="improve">개선</option>
              <option value="bug">오류/잘못된 점</option>
              <option value="other">기타</option>
            </select>
          </div>
          <TextField
            label="연락처(선택)"
            value={form.contact}
            onChange={(v) => setForm((p) => ({ ...p, contact: v }))}
            placeholder="이메일/디스코드 등"
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 12 }}>
          <Select
            label={"공개 설정"}
            value={form.visibility}
            onChange={(v) => setForm((p) => ({ ...p, visibility: v }))}
            options={[
              { value: "public", label: "공개" },
              { value: "private", label: "비공개(관리자만)" },
            ]}
          />
          <TextField
            label="제목"
            value={form.title}
            onChange={(v) => setForm((p) => ({ ...p, title: v }))}
            placeholder="예: 재료 시세 입력이 불편해요"
          />
          <TextArea
            label="내용"
            value={form.body}
            onChange={(v) => setForm((p) => ({ ...p, body: v }))}
            placeholder="어떤 문제가 있었는지, 개선 아이디어를 자세히 적어주세요."
            rows={5}
          />
        </div>

        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={submit}
            disabled={!canSubmit}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid var(--input-border)",
              background: canSubmit ? "var(--accent)" : "var(--panel-bg)",
              color: canSubmit ? "var(--accent-text)" : "var(--muted)",
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontWeight: 900,
              fontSize: 13,
            }}
          >
            제보 등록
          </button>
        </div>
      </Card>

      <Card title="문의 관리">
        {items.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>등록된 문의가 없습니다.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {items.map((item) => (
              <div
                key={item.id}
                style={{
                  border: "1px solid var(--soft-border)",
                  borderRadius: 12,
                  padding: 12,
                  background: "var(--panel-bg)",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 900 }}>
                    [{typeLabel(item.type)}] {item.title}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {item.createdAt?.toDate ? item.createdAt.toDate().toLocaleString("ko-KR") : "-"}
                  </div>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>{item.body}</div>
                {item.contact ? (
                  <div style={{ fontSize: 12, opacity: 0.8 }}>연락처: {item.contact}</div>
                ) : null}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    공개: {item.visibility === "private" ? "비공개" : "공개"}
                  </div>
                  {item.reply ? (
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>관리자 답변 완료</div>
                  ) : null}
                </div>
                {item.reply ? (
                  <div style={{ padding: 10, borderRadius: 10, background: "var(--soft-bg)", border: "1px solid var(--soft-border)", fontSize: 13 }}>
                    <div style={{ fontWeight: 900, marginBottom: 4 }}>관리자 답변</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{item.reply}</div>
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>상태</div>
                  {isAdmin ? (
                    <select
                      value={item.status || "new"}
                      onChange={(e) => updateStatus(item.id, e.target.value)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid var(--input-border)",
                        outline: "none",
                        fontSize: 13,
                        background: "var(--input-bg)",
                        color: "var(--text)",
                      }}
                    >
                      <option value="new">접수</option>
                      <option value="progress">진행중</option>
                      <option value="done">완료</option>
                    </select>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{statusLabel(item.status)}</div>
                  )}
                  {isAdmin ? (
                    <button
                      onClick={() => removeItem(item.id)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid var(--input-border)",
                        background: "var(--panel-bg)",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      삭제
                    </button>
                  ) : null}
                </div>
                {isAdmin ? (
                  <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
                    <TextArea
                      label="관리자 답변"
                      value={replyDrafts[item.id] ?? ""}
                      onChange={(v) => setReplyDrafts((p) => ({ ...p, [item.id]: v }))}
                      placeholder="답변을 입력하세요"
                      rows={3}
                    />
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button
                        onClick={() => {
                          saveReply(item.id, replyDrafts[item.id] ?? "");
                        }}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid var(--input-border)",
                          background: "var(--accent)",
                          color: "var(--accent-text)",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 900,
                        }}
                      >
                        답변 저장
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}


function ProfilePage({
  s,
  setS,
  feeRate,
  priceUpdatedAt,
  priceUpdatedBy,
  authUser,
  userDoc,
  onSaveNickname,
  onSaveCommonPrices,
  commonPriceSaving,
  commonPriceError,
  onSaveMaterialPrices,
  materialPriceSaving,
  materialPriceError,
  nicknameSaving,
  nicknameError,
}) {
  const [nickname, setNickname] = useState("");

  useEffect(() => {
    if (!authUser) {
      setNickname("");
      return;
    }
    setNickname(userDoc?.nickname ?? authUser.displayName ?? "");
  }, [authUser, userDoc]);
  const sageOptions = useMemo(() => {
    const values = Object.keys(SAGE_SHARDS_BY_ENH).map(Number).sort((a, b) => a - b);
    return values.map((v) => ({ value: v, label: `${v}강 (조각 ${SAGE_SHARDS_BY_ENH[v]}개)` }));
  }, []);

  const gemOptions = [
    { value: 0, label: "0레벨 (스킬 없음)" },
    { value: 1, label: "1레벨 (3% 확률, 1개)" },
    { value: 2, label: "2레벨 (7% 확률, 1개)" },
    { value: 3, label: "3레벨 (10% 확률, 2개)" },
  ];

  const flameOptions = [
    { value: 0, label: "0레벨 (스킬 없음)" },
    ...Array.from({ length: 9 }, (_, i) => {
      const lv = i + 1;
      return { value: lv, label: `${lv}레벨 (${lv}% 확률, 조각→주괴 1개 대체)` };
    }),
    { value: 10, label: "10레벨 (15% 확률, 조각→주괴 1개 대체)" },
  ];


  const shardsPerDig = SAGE_SHARDS_BY_ENH[s.sageEnhLevel] ?? 0;
  const gemRule = gemExpertRule(s.gemExpertLevel);
  const flameRule = flamingPickRule(s.flamingPickLevel);

  const materialKeysForUI = [
    "ingot",
    "diamond",
    "gold",
    "iron",
    "lapis",
    "amethyst",
    "copper",
    "redstone",
    "stone",
    "deepCobble",
  ];

  const materialLabels = {
    ingot: "\uc8fc\uad34",
    diamond: "\ub2e4\uc774\uc544\ubaac\ub4dc",
    gold: "\uae08",
    iron: "\ucca0",
    lapis: "\uccad\uae08\uc11d",
    amethyst: "\uc790\uc218\uc815",
    copper: "\uad6c\ub9ac",
    redstone: "\ub808\ub4dc\uc2a4\ud1a4",
    stone: "\uc870\uc57d\ub3cc",
    deepCobble: "\uc2ec\uce35 \uc870\uc57d\ub3cc",
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="내 정보 입력">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "flex-end" }}>
            <TextField
              label="온라인 표시 이름"
              value={nickname}
              onChange={(v) => setNickname(v)}
              placeholder="예: 미래24"
            />
            <button
              onClick={() => onSaveNickname(nickname)}
              disabled={!authUser || nicknameSaving}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid var(--input-border)",
                background: "var(--accent)",
                color: "var(--accent-text)",
                cursor: !authUser || nicknameSaving ? "not-allowed" : "pointer",
                fontWeight: 900,
                fontSize: 12,
                opacity: !authUser || nicknameSaving ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
              title={authUser ? "온라인 표시 이름 저장" : "로그인 후 설정할 수 있습니다."}
            >
              {nicknameSaving ? "저장 중..." : "저장"}
            </button>
          </div>
          {nicknameError ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#c0392b" }}>{nicknameError}</div>
          ) : null}
          <Select
            label={"\ud14c\ub9c8"}
            value={["light", "dark", "purple"].includes(s.themeMode) ? s.themeMode : "light"}
            onChange={(v) => setS((p) => ({ ...p, themeMode: v }))}
            options={[
              { value: "light", label: "\ub77c\uc774\ud2b8 \ubaa8\ub4dc" },
              { value: "dark", label: "\ub2e4\ud06c \ubaa8\ub4dc" },
              { value: "purple", label: "\ud37c\ud50c \ubaa8\ub4dc" },
            ]}
          />
          <Select
            label="\uc138\uc774\uc9c0 \uace1\uad2d\uc774 \uac15\ud654 \ub2e8\uacc4"
            value={s.sageEnhLevel}
            onChange={(v) => setS((p) => ({ ...p, sageEnhLevel: v }))}
            options={sageOptions}
          />
          <Select
            label="\ubcf4\uc11d \uc804\ubb38\uac00 \ub808\ubca8"
            value={s.gemExpertLevel}
            onChange={(v) => setS((p) => ({ ...p, gemExpertLevel: v }))}
            options={gemOptions}
          />
          <Select
            label="\ubd88\ubd99\uc740 \uace1\uad2d\uc774 \ub808\ubca8"
            value={s.flamingPickLevel}
            onChange={(v) => setS((p) => ({ ...p, flamingPickLevel: v }))}
            options={flameOptions}
          />
          <Field
            label="\uc2a4\ud0dc\ubbf8\ub098 1\ud68c \uc18c\ubaa8\ub7c9"
            value={s.staminaPerDig}
            onChange={(v) => setS((p) => ({ ...p, staminaPerDig: v }))}
            placeholder="\uc608: 10"
            min={1}
          />
          <Field
            label="\uc870\uac01->\uc8fc\uad34 \ud544\uc694 \uc870\uac01"
            value={s.shardsPerIngot}
            onChange={(v) => setS((p) => ({ ...p, shardsPerIngot: v }))}
            placeholder="\uc608: 16"
            min={1}
          />
        </div>

        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "var(--soft-bg)", border: "1px solid var(--soft-border)" }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>\ud604\uc7ac \ub0b4\uc815\ubcf4 \uc694\uc57d</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13 }}>
            <div>
              \uc870\uac01/\ud68c(\ubd88\ubd99\uc740 \ubbf8\ubc1c\ub3d9 \uc2dc): <b>{fmt(shardsPerDig)}</b>
            </div>
            <div>
              \ubcf4\uc11d: <b>{fmt(gemRule.prob * 100)}%</b>, <b>{fmt(gemRule.count)}</b>\uac1c
            </div>
            <div>
              \ubd88\ubd99\uc740(\ub300\uccb4): <b>{fmt(flameRule.prob * 100)}%</b> \ud655\ub960, <b>\uc8fc\uad34 1\uac1c</b>
            </div>
            <div>
              \ud310\ub9e4 \uc218\uc218\ub8cc: <b>{fmt(toNum(s.feePct))}%</b>
            </div>
          </div>
        </div>
      </Card>

      <Card title="시세 입력 (공통)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <Field
            label="판매 수수료(%)"
            value={s.feePct}
            onChange={(v) => setS((p) => ({ ...p, feePct: v }))}
            placeholder="예: 5"
            min={0}
            max={50}
            suffix="%"
          />
          <Field
            label="주괴 시장가(원)"
            value={s.ingotGrossPrice}
            onChange={(v) =>
              setS((p) => ({
                ...p,
                ingotGrossPrice: v,
                prices: { ...p.prices, ingot: { market: v } },
              }))
            }
            placeholder="예: 6000"
            min={0}
            suffix="원"
          />
          <Field
            label="보석 시장가(원)"
            value={s.gemGrossPrice}
            onChange={(v) => setS((p) => ({ ...p, gemGrossPrice: v }))}
            placeholder="예: 12000"
            min={0}
            suffix="원"
          />
        </div>

        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          판매 실수령(수수료 반영):
          <br />- 주괴 {fmt(toNum(s.ingotGrossPrice))}원 <b>→ {fmt(netSell(toNum(s.ingotGrossPrice), feeRate))}원</b>
          <br />- 보석 {fmt(toNum(s.gemGrossPrice))}원 <b>→ {fmt(netSell(toNum(s.gemGrossPrice), feeRate))}원</b>
          <br />
          구매 비용(수수료 없음): <b>시장가 그대로</b>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {"\ucd5c\uadfc \uc2dc\uc138 \uc5c5\ub370\uc774\ud2b8: "}
          {priceUpdatedAt ? priceUpdatedAt.toLocaleString("ko-KR") : "-"}
          {priceUpdatedBy ? ` (\uc800\uc7a5\uc790: ${priceUpdatedBy.name || priceUpdatedBy.email || "\uc54c \uc218 \uc5c6\uc74c"})` : ""}
        </div>

        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
          {priceSaveError ? <span style={{ fontSize: 12, color: "#c0392b" }}>{priceSaveError}</span> : null}
          <button
            onClick={onSaveSharedPrices}
            disabled={!authUser || priceSaving}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid var(--input-border)",
              background: authUser ? "var(--panel-bg)" : "transparent",
              color: "var(--text)",
              cursor: !authUser || priceSaving ? "not-allowed" : "pointer",
              fontWeight: 800,
              fontSize: 12,
              opacity: !authUser || priceSaving ? 0.6 : 1,
            }}
            title={authUser ? "\uc2dc\uc138/\uc635\uc158 \uc800\uc7a5" : "\ub85c\uadf8\uc778 \ud6c4 \uc800\uc7a5\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4."}
          >
            {priceSaving ? "\uc800\uc7a5 \uc911..." : "\uc2dc\uc138/\uc635\uc158 \uc800\uc7a5"}
          </button>
        </div>
      </Card>


      <Card title="재료 시세(시장가) + 수급 방식 입력">
        <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
          재료는 시장가 1개만 입력합니다.
          <br />
          판매 실수령 = 시장가 x (1-수수료)
          <br />
          구매 비용 = 시장가(수수료 없음)
        </div>
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
          {materialKeysForUI.map((key) => {
            const label = materialLabels[key] || key;
            const market = s.prices[key]?.market ?? "";
            const mode = s.modes[key] || "owned";
            return (
              <div key={key} style={{ display: "grid", gap: 8, padding: 10, borderRadius: 10, border: "1px solid var(--soft-border)", background: "var(--panel-bg)" }}>
                <Field
                  label={`${label} 시장가(개당)`}
                  value={market}
                  onChange={(v) =>
                    setS((p) => ({
                      ...p,
                      prices: { ...p.prices, [key]: { market: v } },
                    }))
                  }
                  placeholder="예: 1000"
                  min={0}
                  suffix="원"
                />
                <Select
                  label={`${label} 수급 방식`}
                  value={mode}
                  onChange={(v) => setS((p) => ({ ...p, modes: { ...p.modes, [key]: v } }))}
                  options={[
                    { value: "owned", label: "직접 수급(0)" },
                    { value: "buy", label: "구매" },
                    { value: "opportunity", label: "포기한 판매 수익" },
                  ]}
                />
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
          {materialPriceError ? <span style={{ fontSize: 12, color: "#c0392b" }}>{materialPriceError}</span> : null}
          <button
            onClick={onSaveMaterialPrices}
            disabled={!authUser || materialPriceSaving}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid var(--input-border)",
              background: authUser ? "var(--panel-bg)" : "transparent",
              color: "var(--text)",
              cursor: !authUser || materialPriceSaving ? "not-allowed" : "pointer",
              fontWeight: 800,
              fontSize: 12,
              opacity: !authUser || materialPriceSaving ? 0.6 : 1,
            }}
            title={authUser ? "재료 시세 저장" : "로그인 후 저장할 수 있습니다."}
          >
            {materialPriceSaving ? "저장 중..." : "재료 시세 저장"}
          </button>
        </div>
      </Card>
    </div>
  );
}

/**
 * ==========
 * Root App
 * ==========
 */
function VillageSuggestionPage({ s, onlineUsers, authUser, showProfiles, profiles, setProfiles }) {
  const [form, setForm] = useState({
    type: "improve",
    title: "",
    body: "",
    contact: "",
    visibility: "public",
  });
  const [customType, setCustomType] = useState("");

  const [items, setItems] = useState([]);
  const [replyDrafts, setReplyDrafts] = useState({});
  const isAdmin = s.adminMode === true;
  const canSubmit = form.title.trim() && form.body.trim();
  const [clientId] = useState(() => getClientId());
  const [profileForm, setProfileForm] = useState({
    nickname: "",
    mcNickname: "",
    birthday: "",
    age: "",
    mbti: "",
    job: "",
    rank: "",
    likes: "",
    dislikes: "",
  });
  const [profileTouched, setProfileTouched] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");

  useEffect(() => {
    const q = query(collection(db, "villageSuggestions"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const visible = isAdmin
        ? rows
        : rows.filter((r) => r.visibility !== "private" || r.authorId === clientId);
      setItems(visible);
    });
    return () => unsub();
  }, [isAdmin, clientId]);

  useEffect(() => {
    if (!authUser || profileTouched) return;
    const mine = profiles.find((p) => p.uid === authUser.uid);
    if (!mine) {
      setProfileForm({
        nickname: "",
        mcNickname: "",
        birthday: "",
        age: "",
        mbti: "",
        job: "",
        rank: "",
        likes: "",
        dislikes: "",
      });
      return;
    }
    setProfileForm({
      nickname: mine.nickname || "",
      mcNickname: mine.mcNickname || "",
      birthday: mine.birthday || "",
      age: mine.age || "",
      mbti: mine.mbti || "",
      job: mine.job || "",
      rank: mine.rank || "",
      likes: mine.likes || "",
      dislikes: mine.dislikes || "",
    });
  }, [authUser, profiles, profileTouched]);

  useEffect(() => {
    setReplyDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      items.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = item.reply || "";
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [items]);

  const submit = () => {
    if (!canSubmit) return;
    const finalType = form.type === "other" ? customType.trim() || "기타" : form.type;
    addDoc(collection(db, "villageSuggestions"), {
      type: finalType,
      title: form.title.trim(),
      body: form.body.trim(),
      contact: form.contact.trim(),
      visibility: form.visibility,
      authorId: clientId,
      status: "new",
      createdAt: serverTimestamp(),
    });
    setForm({ type: "improve", title: "", body: "", contact: "", visibility: "public" });
    setCustomType("");
  };

  const updateStatus = (id, status) => {
    if (!isAdmin) return;
    updateDoc(doc(db, "villageSuggestions", id), { status });
  };

  const removeItem = (id) => {
    if (!isAdmin) return;
    deleteDoc(doc(db, "villageSuggestions", id));
  };

  const saveReply = (id, reply) => {
    if (!isAdmin) return;
    const trimmed = (reply || "").trim();
    updateDoc(doc(db, "villageSuggestions", id), {
      reply: trimmed,
      repliedAt: trimmed ? serverTimestamp() : null,
      status: trimmed ? "done" : "progress",
    });
  };

  const typeLabel = (type) => (type ? String(type) : "\uae30\ud0c0");

  const statusLabel = (status) => {
    if (status === "progress") return "\uc9c4\ud589\uc911";
    if (status === "done") return "\uc644\ub8cc";
    return "\uc811\uc218";
  };

  const handleProfileChange = (key, value) => {
    setProfileTouched(true);
    setProfileForm((p) => ({ ...p, [key]: value }));
  };

  const existingProfile = useMemo(() => {
    if (!authUser) return null;
    return profiles.find((p) => p.uid === authUser.uid) || null;
  }, [authUser, profiles]);

  const saveProfile = async () => {
    if (!authUser) return;
    setProfileSaving(true);
    setProfileError("");
    const payload = {
      uid: authUser.uid,
      nickname: profileForm.nickname.trim(),
      mcNickname: profileForm.mcNickname.trim(),
      birthday: profileForm.birthday.trim(),
      age: profileForm.age.trim(),
      mbti: profileForm.mbti.trim(),
      job: profileForm.job.trim(),
      rank: profileForm.rank || "",
      likes: profileForm.likes.trim(),
      dislikes: profileForm.dislikes.trim(),
      updatedAt: serverTimestamp(),
    };
    if (!existingProfile?.createdAt) {
      payload.createdAt = serverTimestamp();
    }
    try {
      setProfiles((prev) => {
        const next = Array.isArray(prev) ? [...prev] : [];
        const idx = next.findIndex((p) => p.uid === authUser.uid);
        const optimistic = {
          ...(idx >= 0 ? next[idx] : {}),
          ...payload,
          updatedAt: new Date(),
          createdAt: idx >= 0 ? next[idx]?.createdAt : new Date(),
        };
        if (idx >= 0) next[idx] = optimistic;
        else next.push(optimistic);
        return next;
      });
      await Promise.race([
        setDoc(doc(db, "villageProfiles", authUser.uid), payload, { merge: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
      setProfileTouched(false);
    } catch (err) {
      if (err?.code === "resource-exhausted") {
        try {
          localStorage.setItem(
            `pendingProfile:${authUser.uid}`,
            JSON.stringify({ payload, ts: Date.now() })
          );
        } catch {
          // ignore localStorage failures
        }
        setProfileError("저장량이 잠시 초과되었습니다. 로컬에 임시 저장했고 자동 재시도합니다.");
      } else if (err?.message === "timeout") {
        try {
          localStorage.setItem(
            `pendingProfile:${authUser.uid}`,
            JSON.stringify({ payload, ts: Date.now() })
          );
        } catch {
          // ignore localStorage failures
        }
        setProfileError("저장이 지연되고 있습니다. 로컬에 임시 저장했고 자동 재시도합니다.");
      } else {
        setProfileError("프로필 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      setProfileSaving(false);
    }
  };

  const deleteProfile = async () => {
    if (!authUser) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      setProfiles((prev) => prev.filter((p) => p.uid !== authUser.uid));
      await Promise.race([
        deleteDoc(doc(db, "villageProfiles", authUser.uid)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
      setProfileForm({
        nickname: "",
        mcNickname: "",
        birthday: "",
        age: "",
        mbti: "",
        job: "",
        rank: "",
        likes: "",
        dislikes: "",
      });
      setProfileTouched(false);
    } catch (err) {
      if (err?.code === "resource-exhausted" || err?.message === "timeout") {
        setProfileError("삭제가 지연되고 있습니다. 잠시 후 다시 시도해주세요.");
      } else {
        setProfileError("프로필 삭제에 실패했습니다. 잠시 후 다시 시도해주세요.");
      }
    } finally {
      setProfileSaving(false);
    }
  };

  const resetProfileForm = () => {
    setProfileForm({
      nickname: "",
      mcNickname: "",
      birthday: "",
      age: "",
      mbti: "",
      job: "",
      rank: "",
      likes: "",
      dislikes: "",
    });
    setProfileTouched(true);
  };

  const rankOrder = ["이장", "부이장", "주민대표", "거주민", "입주자", "알바"];
  const sortedProfiles = useMemo(() => {
    const order = new Map(rankOrder.map((rank, idx) => [rank, idx]));
    return [...profiles].sort((a, b) => {
      const ra = order.has(a.rank) ? order.get(a.rank) : rankOrder.length;
      const rb = order.has(b.rank) ? order.get(b.rank) : rankOrder.length;
      if (ra !== rb) return ra - rb;
      const an = a.nickname || a.mcNickname || "";
      const bn = b.nickname || b.mcNickname || "";
      return an.localeCompare(bn);
    });
  }, [profiles]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {!showProfiles ? (
        <Card title={"마을 건의함"}>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
            {"마을 관련 건의/문의는 여기에 남겨주세요."}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>유형</div>
              <select
                value={form.type}
                onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  outline: "none",
                  fontSize: 14,
                  background: "var(--input-bg)",
                  color: "var(--text)",
                }}
              >
                <option value="improve">개선</option>
                <option value="bug">오류/잘못된 점</option>
                <option value="other">기타(직접 입력)</option>
              </select>
            </div>
            <TextField
              label="연락처(선택)"
              value={form.contact}
              onChange={(v) => setForm((p) => ({ ...p, contact: v }))}
              placeholder="이메일/디스코드 등"
            />
          </div>

          {form.type === "other" ? (
            <div style={{ marginTop: 12 }}>
              <TextField
                label="기타 유형"
                value={customType}
                onChange={(v) => setCustomType(v)}
                placeholder="예: 이벤트/시설/상점"
              />
            </div>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 12 }}>
            <Select
              label={"공개 설정"}
              value={form.visibility}
              onChange={(v) => setForm((p) => ({ ...p, visibility: v }))}
              options={[
                { value: "public", label: "공개" },
                { value: "private", label: "비공개(관리자만)" },
              ]}
            />
            <TextField
              label="제목"
              value={form.title}
              onChange={(v) => setForm((p) => ({ ...p, title: v }))}
              placeholder="예: 마을 상점에 아이템 추가 요청"
            />
            <TextArea
              label="내용"
              value={form.body}
              onChange={(v) => setForm((p) => ({ ...p, body: v }))}
              placeholder="건의 내용을 자세히 적어주세요."
              rows={5}
            />
          </div>

          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button
              onClick={submit}
              disabled={!canSubmit}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid var(--input-border)",
                background: canSubmit ? "var(--accent)" : "var(--panel-bg)",
                color: canSubmit ? "var(--accent-text)" : "var(--muted)",
                cursor: canSubmit ? "pointer" : "not-allowed",
                fontWeight: 900,
                fontSize: 13,
              }}
            >
              등록
            </button>
          </div>
        </Card>
      ) : null}

      {showProfiles ? (
        <Card title="마을원 프로필">
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 10 }}>
              {sortedProfiles.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.7 }}>등록된 마을원 프로필이 없습니다.</div>
              ) : (
                sortedProfiles.map((p) => (
                  <div
                    key={p.uid}
                    style={{
                      padding: 12,
                      borderRadius: 12,
                      border: "1px solid var(--soft-border)",
                      background: "var(--panel-bg)",
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>
                      {p.nickname || p.mcNickname || "\uc774\ub984 \uc5c6\uc74c"}
                      {p.mcNickname ? ` (${p.mcNickname})` : ""}
                    </div>
                    {p.rank ? <div style={{ fontSize: 12, opacity: 0.85 }}>직급: {p.rank}</div> : null}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6, fontSize: 12 }}>
                      <div>생일: {p.birthday || "-"}</div>
                      <div>나이: {p.age || "-"}</div>
                      <div>MBTI: {p.mbti || "-"}</div>
                      <div>마크 직업: {p.job || "-"}</div>
                    </div>
                    {p.likes ? <div style={{ fontSize: 12 }}>좋아하는 것: {p.likes}</div> : null}
                    {p.dislikes ? <div style={{ fontSize: 12 }}>싫어하는 것: {p.dislikes}</div> : null}
                  </div>
                ))
              )}
            </div>

            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {authUser ? "내 프로필을 입력하거나 수정할 수 있습니다." : "로그인 후 프로필을 입력할 수 있습니다."}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
              <TextField
                label="닉네임"
                value={profileForm.nickname}
                onChange={(v) => handleProfileChange("nickname", v)}
                placeholder="예: 미래24"
              />
              <TextField
                label="마크 닉네임"
                value={profileForm.mcNickname}
                onChange={(v) => handleProfileChange("mcNickname", v)}
                placeholder="예: Mirae24"
              />
              <TextField
                label="생일"
                type="date"
                value={profileForm.birthday}
                onChange={(v) => handleProfileChange("birthday", v)}
                placeholder="YYYY-MM-DD"
              />
              <TextField
                label="나이"
                type="number"
                value={profileForm.age}
                onChange={(v) => handleProfileChange("age", v)}
                placeholder="예: 21"
              />
              <TextField
                label="MBTI"
                value={profileForm.mbti}
                onChange={(v) => handleProfileChange("mbti", v)}
                placeholder="예: INFP"
              />
              <TextField
                label="마크 직업"
                value={profileForm.job}
                onChange={(v) => handleProfileChange("job", v)}
                placeholder="예: 건축가"
              />
              <Select
                label="직급"
                value={profileForm.rank}
                onChange={(v) => handleProfileChange("rank", v)}
                options={[
                  { value: "이장", label: "이장" },
                  { value: "부이장", label: "부이장" },
                  { value: "주민대표", label: "주민대표" },
                  { value: "거주민", label: "거주민" },
                  { value: "입주자", label: "입주자" },
                  { value: "알바", label: "알바" },
                ]}
              />
              <div style={{ gridColumn: "1 / -1" }}>
                <TextArea
                  label="좋아하는 것"
                  value={profileForm.likes}
                  onChange={(v) => handleProfileChange("likes", v)}
                  placeholder="좋아하는 것을 적어 주세요."
                  rows={3}
                />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <TextArea
                  label="싫어하는 것"
                  value={profileForm.dislikes}
                  onChange={(v) => handleProfileChange("dislikes", v)}
                  placeholder="싫어하는 것을 적어 주세요."
                  rows={3}
                />
              </div>
            </div>

            {profileError ? <div style={{ fontSize: 12, color: "#c0392b" }}>{profileError}</div> : null}

            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {existingProfile ? "내 프로필이 있습니다. 수정/삭제할 수 있습니다." : "프로필을 생성해주세요."}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={resetProfileForm}
                disabled={!authUser || profileSaving}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--panel-bg)",
                  cursor: !authUser || profileSaving ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  fontSize: 13,
                  opacity: !authUser || profileSaving ? 0.6 : 1,
                }}
              >
                {"새 프로필"}
              </button>
              <button
                onClick={saveProfile}
                disabled={!authUser || profileSaving}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--accent)",
                  color: "var(--accent-text)",
                  cursor: !authUser || profileSaving ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  fontSize: 13,
                  opacity: !authUser || profileSaving ? 0.6 : 1,
                }}
              >
                {profileSaving ? "저장 중..." : existingProfile ? "프로필 수정" : "프로필 생성"}
              </button>
              <button
                onClick={deleteProfile}
                disabled={!authUser || profileSaving || !existingProfile}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--panel-bg)",
                  cursor: !authUser || profileSaving || !existingProfile ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  fontSize: 13,
                  opacity: !authUser || profileSaving || !existingProfile ? 0.6 : 1,
                }}
              >
                {"프로필 삭제"}
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {!showProfiles ? (
        <>
          <Card title={"건의 관리"}>
            {items.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.8 }}>등록된 건의가 없습니다.</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      border: "1px solid var(--soft-border)",
                      borderRadius: 12,
                      padding: 12,
                      background: "var(--panel-bg)",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 900 }}>
                        [{typeLabel(item.type)}] {item.title}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        {item.createdAt?.toDate ? item.createdAt.toDate().toLocaleString("ko-KR") : "-"}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{item.body}</div>
                    {item.contact ? (
                      <div style={{ fontSize: 12, opacity: 0.8 }}>연락처: {item.contact}</div>
                    ) : null}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        공개: {item.visibility === "private" ? "비공개" : "공개"}
                      </div>
                      {item.reply ? (
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>
                          관리자 답변 완료
                        </div>
                      ) : null}
                    </div>
                    {item.reply ? (
                      <div
                        style={{
                          padding: 10,
                          borderRadius: 10,
                          background: "var(--soft-bg)",
                          border: "1px solid var(--soft-border)",
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 900, marginBottom: 4 }}>관리자 답변</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{item.reply}</div>
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>상태</div>
                      {isAdmin ? (
                        <select
                          value={item.status || "new"}
                          onChange={(e) => updateStatus(item.id, e.target.value)}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid var(--input-border)",
                            outline: "none",
                            fontSize: 13,
                            background: "var(--input-bg)",
                            color: "var(--text)",
                          }}
                        >
                          <option value="new">접수</option>
                          <option value="progress">진행중</option>
                          <option value="done">완료</option>
                        </select>
                      ) : (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>{statusLabel(item.status)}</div>
                      )}
                      {isAdmin ? (
                        <button
                          onClick={() => removeItem(item.id)}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid var(--input-border)",
                            background: "var(--panel-bg)",
                            color: "var(--text)",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          삭제
                        </button>
                      ) : null}
                    </div>
                    {isAdmin ? (
                      <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
                        <TextArea
                          label="관리자 답변"
                          value={replyDrafts[item.id] ?? ""}
                          onChange={(v) => setReplyDrafts((p) => ({ ...p, [item.id]: v }))}
                          placeholder="답변을 입력하세요"
                          rows={3}
                        />
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            onClick={() => saveReply(item.id, replyDrafts[item.id] ?? "")}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--input-border)",
                              background: "var(--accent)",
                              color: "var(--accent-text)",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 900,
                            }}
                          >
                            답변 저장
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={"현재 접속 중"}>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
          {`온라인 ${onlineUsers.length}명`}
            </div>
            {onlineUsers.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>접속 중인 사용자가 없습니다.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {onlineUsers.map((user) => (
                  <div
                    key={user.id}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: "1px solid var(--soft-border)",
                      background: "var(--panel-bg)",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {user.displayName || user.email || "익명"}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}


function IngotPage({ s, setS, feeRate, priceUpdatedAt, priceUpdatedBy, onSaveSharedPrices, priceSaving, priceSaveError, authUser }) {
  const materialLabels = {
    ingot: "\uc8fc\uad34",
    stone: "\uc870\uc57d\ub3cc",
    deepCobble: "\uc2ec\uce35 \uc870\uc57d\ub3cc",
    redstone: "\ub808\ub4dc\uc2a4\ud1a4",
    copper: "\uad6c\ub9ac",
    diamond: "\ub2e4\uc774\uc544\ubaac\ub4dc \ube14\ub7ed",
    iron: "\ucca0",
    lapis: "\uccad\uae08\uc11d",
    gold: "\uae08 \ube14\ub7ed",
    amethyst: "\uc790\uc218\uc815",
  };

  const formatBuySummary = (list) => {
    const items = (list || []).filter((x) => (x.qty || 0) > 0);
    if (items.length === 0) return "";
    return items
      .map((x) => {
        const name = materialLabels[x.key] ?? x.key;
        return `${name} ${x.qty}\uac1c`;
      })
      .join(", ");
  };

  const formatSellSummary = (recipe) => {
    const items = Object.entries(recipe || {})
      .map(([k, qty]) => ({ key: k, qty: qty || 0, mode: s.modes[k] || "owned" }))
      .filter((x) => x.qty > 0 && x.mode !== "buy");
    if (items.length === 0) return "\ud310\ub9e4 \uc5c6\uc74c";
    return items
      .map((x) => {
        const name = materialLabels[x.key] ?? x.key;
        return `${name} ${x.qty}\uac1c`;
      })
      .join(", ");
  };

  // gem expert rule by level
  const shardsPerDig = SAGE_SHARDS_BY_ENH[s.sageEnhLevel] ?? 0;
  const gemRule = gemExpertRule(s.gemExpertLevel);
  const flameRule = flamingPickRule(s.flamingPickLevel);

  const ev = useMemo(() => {
    return miningEVBreakdown({
      staminaPerDig: toNum(s.staminaPerDig, 10),
      shardsPerDig,
      shardsPerIngot: toNum(s.shardsPerIngot, 16),
      ingotGrossPrice: toNum(s.ingotGrossPrice, 0),
      gemDropProb: gemRule.prob,
      gemDropCount: gemRule.count,
      gemGrossPrice: toNum(s.gemGrossPrice, 0),
      flamingIngotProb: flameRule.prob,
      sellFeeRate: feeRate,
    });
  }, [
    s.staminaPerDig,
    shardsPerDig,
    s.shardsPerIngot,
    s.ingotGrossPrice,
    gemRule.prob,
    gemRule.count,
    s.gemGrossPrice,
    flameRule.prob,
    feeRate,
  ]);

  // gem expert rule by level
  const compare = useMemo(() => {
    const sellIndivNet = (recipe) => {
      return sum(
        Object.entries(recipe).map(([k, qty]) => {
          const mode = s.modes[k] || "owned";
          if (mode === "buy") return 0;
          const market = toNum(s.prices[k]?.market ?? 0);
          return (qty || 0) * netSell(market, feeRate);
        })
      );
    };

    const craft = (productGrossPrice, recipe) => {
      const costs = Object.entries(recipe).map(([k, qty]) => {
        const mode = s.modes[k] || "owned";
        const market = toNum(s.prices[k]?.market ?? 0);
        const unitCost = unitCostByMode({ mode, marketPrice: market, feeRate });
        return { key: k, qty: qty || 0, unitCost, mode, market };
      });
      const buyList = costs.filter((c) => c.mode === "buy").map((c) => ({ key: c.key, qty: c.qty || 0 }));
      return { ...craftProfit({ productGrossSellPrice: toNum(productGrossPrice), feeRate, costs }), costs, buyList };
    };

    const ability = craft(s.abilityGrossSell, s.recipes.ability);
    const abilitySellIndiv = sellIndivNet(s.recipes.ability);

    const low = craft(s.lifeGrossSell.low, s.recipes.low);
    const lowSellIndiv = sellIndivNet(s.recipes.low);

    const mid = craft(s.lifeGrossSell.mid, s.recipes.mid);
    const midSellIndiv = sellIndivNet(s.recipes.mid);

    const high = craft(s.lifeGrossSell.high, s.recipes.high);
    const highSellIndiv = sellIndivNet(s.recipes.high);

    const deltaByRounded = (profit, sellIndivNet) => Math.round(profit) - Math.round(sellIndivNet);

    return {
      ability: {
        ...ability,
        sellIndivNet: abilitySellIndiv,
        deltaRevenueVsIndiv: deltaByRounded(ability.profit, abilitySellIndiv),
      },
      low: {
        ...low,
        sellIndivNet: lowSellIndiv,
        deltaRevenueVsIndiv: deltaByRounded(low.profit, lowSellIndiv),
      },
      mid: {
        ...mid,
        sellIndivNet: midSellIndiv,
        deltaRevenueVsIndiv: deltaByRounded(mid.profit, midSellIndiv),
      },
      high: {
        ...high,
        sellIndivNet: highSellIndiv,
        deltaRevenueVsIndiv: deltaByRounded(high.profit, highSellIndiv),
      },
    };
  }, [s.prices, s.modes, s.recipes, s.abilityGrossSell, s.lifeGrossSell, feeRate]);

  // gem expert rule by level 토글: 화면을 복잡하게 만들지 않기 위해 여기만 둠
  const [detailOpen, setDetailOpen] = useState(false);

  const explain = (x) => {
    const buySpend = sum(
      (x.costs || [])
        .filter((c) => c.mode === "buy")
        .map((c) => (c.qty || 0) * Math.max(0, c.market || 0))
    );

    const foregone = sum(
      (x.costs || [])
        .filter((c) => c.mode === "opportunity")
        .map((c) => (c.qty || 0) * netSell(Math.max(0, c.market || 0), feeRate))
    );

    const ownedQty = sum((x.costs || []).filter((c) => c.mode === "owned").map((c) => c.qty || 0));

    return { buySpend, foregone, ownedQty };
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="주괴/보석 기대값 (내정보 기반)">
        <div style={{ marginBottom: 10, fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          아래 기대값은 모두 <b>실수령 기준</b>입니다. (판매 수수료 {fmt(toNum(s.feePct))}% 반영)
        </div>

        <div style={{ padding: 12, borderRadius: 12, background: "var(--soft-bg)", border: "1px solid var(--soft-border)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, fontSize: 13 }}>
            <div>회당 조각(미발동 시)</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(shardsPerDig)}개</div>
            <div>불붙은 확률 p(대체)</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(flameRule.prob * 100)}%</div>
            <div>회당 주괴(조각→환산) 기대</div><div style={{ textAlign: "right", fontWeight: 900 }}>{ev.ingotFromShardsPerDig.toFixed(4)}개</div>
            <div>회당 주괴(불붙은 대체) 기대</div><div style={{ textAlign: "right", fontWeight: 900 }}>{ev.ingotFromFlamePerDig.toFixed(4)}개</div>
            <div>회당 보석 기대가치</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.gemValuePerDig)}원</div>
            <div>회당 총 기대가치</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.totalPerDig)}원</div>
            <div>스태미나 1당 기대가치</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.totalPerStamina)}원</div>
          </div>
        </div>
      </Card>

      <Card title="가공 비교: 재료 그대로 판매 vs 어빌/라이프스톤">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <Field
            label="어빌리티 스톤 판매가(시장가)"
            value={s.abilityGrossSell}
            onChange={(v) => setS((p) => ({ ...p, abilityGrossSell: v }))}
          />
          <Field
            label="하급 라이프스톤 판매가(시장가)"
            value={s.lifeGrossSell.low}
            onChange={(v) => setS((p) => ({ ...p, lifeGrossSell: { ...p.lifeGrossSell, low: v } }))}
          />
          <Field
            label="중급 라이프스톤 판매가(시장가)"
            value={s.lifeGrossSell.mid}
            onChange={(v) => setS((p) => ({ ...p, lifeGrossSell: { ...p.lifeGrossSell, mid: v } }))}
          />
          <Field
            label="상급 라이프스톤 판매가(시장가)"
            value={s.lifeGrossSell.high}
            onChange={(v) => setS((p) => ({ ...p, lifeGrossSell: { ...p.lifeGrossSell, high: v } }))}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {"\ucd5c\uadfc \uc2dc\uc138 \uc5c5\ub370\uc774\ud2b8: "}
          {priceUpdatedAt ? priceUpdatedAt.toLocaleString("ko-KR") : "-"}
          {priceUpdatedBy ? ` (\uc800\uc7a5\uc790: ${priceUpdatedBy.name || priceUpdatedBy.email || "\uc54c \uc218 \uc5c6\uc74c"})` : ""}
        </div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
          {priceSaveError ? <span style={{ fontSize: 12, color: "#c0392b" }}>{priceSaveError}</span> : null}
          <button
            onClick={onSaveSharedPrices}
            disabled={!authUser || priceSaving}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid var(--input-border)",
              background: authUser ? "var(--panel-bg)" : "transparent",
              color: "var(--text)",
              cursor: !authUser || priceSaving ? "not-allowed" : "pointer",
              fontWeight: 800,
              fontSize: 12,
              opacity: !authUser || priceSaving ? 0.6 : 1,
            }}
            title={authUser ? "\uac00\uacf5 \uc2dc\uc138 \uc800\uc7a5" : "\ub85c\uadf8\uc778 \ud6c4 \uc800\uc7a5\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4."}
          >
            {priceSaving ? "\uc800\uc7a5 \uc911..." : "\uac00\uacf5 \uc2dc\uc138 \uc800\uc7a5"}
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          표의 의미:
          <br />- <b>재료 그대로 판매 실수령</b>: 같은 재료를 그냥 팔았을 때(기준선)
          <br />- <b>제작 판매 실수령</b>: 결과물을 만들어 팔았을 때
          <br />- <b>제작 순이익</b>: 선택한 수급 방식(직접수급/구매/포기한 판매수익)에 따른 “현재 내 상황 기준” 결과
        </div>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>항목</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>제작 판매 실수령</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>사용된 재료 가치(선택 기준)</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>제작 순이익</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>
                  재료 그대로 판매 실수령(구매 제외)
                </th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>추천</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: "어빌리티 스톤", key: "ability" },
                { name: "하급 라이프스톤", key: "low" },
                { name: "중급 라이프스톤", key: "mid" },
                { name: "상급 라이프스톤", key: "high" },
              ].map((row) => {
                const x = compare[row.key];
                return (
                  <tr key={row.key}>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", fontWeight: 900 }}>{row.name}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>{fmt(x.revenue)}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>
                      {fmt(x.totalCost)}
                      {formatBuySummary(x.buyList) ? (
                        <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.75 }}>
                          &rarr; {formatBuySummary(x.buyList)}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right", fontWeight: 900 }}>{fmt(x.profit)}</td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>
                      {fmt(x.sellIndivNet)}
                      <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.75 }}>
                        &rarr; {formatSellSummary(s.recipes[row.key])}
                      </span>
                    </td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right", fontWeight: 900 }}>
                      {x.profit - x.sellIndivNet >= 0 ? "제작 이득" : "재료 판매 이득"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <ToggleButton
            isOn={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
            labelOn="\uC790\uC138\uD788\uBCF4\uAE30 \uB2EB\uAE30"
            labelOff="\uC790\uC138\uD788\uBCF4\uAE30(\uD3EC\uAE30\uD55C \uD310\uB9E4 \uC218\uC775)"
          />
        </div>

        {detailOpen ? (
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {[
              { name: "\uC5B4\uBE4C\uB9AC\uD2F0 \uC2A4\uD1A4", key: "ability" },
              { name: "\uD558\uAE09 \uB77C\uC774\uD504\uC2A4\uD1A4", key: "low" },
              { name: "\uC911\uAE09 \uB77C\uC774\uD504\uC2A4\uD1A4", key: "mid" },
              { name: "\uC0C1\uAE09 \uB77C\uC774\uD504\uC2A4\uD1A4", key: "high" },
            ].map((row) => {
              const x = compare[row.key];
              const ex = explain(x);
              return (
                <div key={row.key} style={{ padding: 12, borderRadius: 12, border: "1px solid var(--soft-border)", background: "var(--panel-bg)" }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{row.name} {"\uC0C1\uC138 \uACC4\uC0B0(\uC218\uAE09 \uAE30\uC900)"}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, fontSize: 13 }}>
                    <div>{"\uAD6C\uB9E4 \uBE44\uC6A9(\uC2DC\uC7A5\uAC00)"}</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ex.buySpend)}{"\uC6D0"}</div>
                    <div>{"\uD3EC\uAE30\uD55C \uD310\uB9E4 \uC218\uC775(\uC218\uC218\uB8CC \uBC18\uC601)"}</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ex.foregone)}{"\uC6D0"}</div>
                    <div>{"\uBCF4\uC720 \uC7AC\uB8CC \uC218\uB7C9"}</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ex.ownedQty)}{"\uAC1C"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

      </Card>
    </div>
  );
}


/**
 * ==========
 * Root App
 * ==========
 */

export default function App() {
  // useLocalStorageState v4->v6 migration fix
  const [s, setS] = useLocalStorageState("miner_eff_v6", defaultState);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [adminError, setAdminError] = useState("");
  const [priceUpdatedAt, setPriceUpdatedAt] = useState(null);
  const [priceUpdatedBy, setPriceUpdatedBy] = useState(null);
  const [commonUpdatedAt, setCommonUpdatedAt] = useState(null);
  const [commonUpdatedBy, setCommonUpdatedBy] = useState(null);
  const [processUpdatedAt, setProcessUpdatedAt] = useState(null);
  const [processUpdatedBy, setProcessUpdatedBy] = useState(null);
  const [materialUpdatedAt, setMaterialUpdatedAt] = useState(null);
  const [materialUpdatedBy, setMaterialUpdatedBy] = useState(null);
  const [commonPriceSaving, setCommonPriceSaving] = useState(false);
  const [commonPriceError, setCommonPriceError] = useState("");
  const [processPriceSaving, setProcessPriceSaving] = useState(false);
  const [processPriceError, setProcessPriceError] = useState("");
  const [materialPriceSaving, setMaterialPriceSaving] = useState(false);
  const [materialPriceError, setMaterialPriceError] = useState("");
  const priceUpdateTimer = useRef(null);
  const suppressPriceWrite = useRef(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [userDoc, setUserDoc] = useState(null);
  const [pendingUsers, setPendingUsers] = useState([]);
  const [presenceDocs, setPresenceDocs] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceSaveError, setPriceSaveError] = useState("");
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState("");
  const [presencePaused, setPresencePaused] = useState(false);
  const presenceWriteAtRef = useRef(0);
  const presencePauseTimerRef = useRef(null);
  const retryInFlightRef = useRef(false);
  const canUseApp = !!authUser && userDoc?.status === "approved";
  const presenceEnabled = canUseApp && !presencePaused;
  const PRESENCE_MIN_WRITE_GAP_MS = 30000;
  const PRESENCE_WRITE_INTERVAL_MS = 60000;
  const PRESENCE_ONLINE_WINDOW_MS = 5 * 60 * 1000;
  const PRESENCE_PAUSE_MS = 5 * 60 * 1000;

  const pendingNicknameKey = (uid) => `pendingNickname:${uid}`;
  const pendingProfileKey = (uid) => `pendingProfile:${uid}`;
    const enqueuePending = (key, payload) => {
    try {
      localStorage.setItem(key, JSON.stringify({ payload, ts: Date.now() }));
    } catch {
      // ignore localStorage failures
    }
  };

  const feeRate = useMemo(() => {
    const v = toNum(s.feePct, 0) / 100;
    return Math.max(0, Math.min(0.5, v));
  }, [s.feePct]);

  const birthdayMap = useMemo(() => {
    const map = {};
    profiles.forEach((p) => {
      if (!p.birthday) return;
      const parts = String(p.birthday).split("-");
      if (parts.length < 3) return;
      const key = `${parts[1]}-${parts[2]}`;
      if (!map[key]) map[key] = [];
      map[key].push(p);
    });
    return map;
  }, [profiles]);

  const calendarInfo = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const monthIndex = calendarMonth.getMonth();
    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 0);
    const daysInMonth = end.getDate();
    const startDay = start.getDay();
    const cells = [];
    for (let i = 0; i < startDay; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
    while (cells.length < 42) cells.push(null);
    return { year, month: monthIndex + 1, cells };
  }, [calendarMonth]);

  const reset = () => {
    try {
      localStorage.removeItem("miner_eff_v6");
    } catch {
      // ignore
    }
    setS(defaultState);
  };

  const pausePresence = () => {
    if (presencePauseTimerRef.current) {
      clearTimeout(presencePauseTimerRef.current);
    }
    setPresencePaused(true);
    presencePauseTimerRef.current = setTimeout(() => {
      setPresencePaused(false);
    }, PRESENCE_PAUSE_MS);
  };

  const saveNickname = async (nextName) => {
    if (!authUser) return;
    const trimmed = (nextName || "").trim();
    setNicknameSaving(true);
    setNicknameError("");
    try {
      const writePromise = setDoc(
        doc(db, "users", authUser.uid),
        {
          nickname: trimmed,
          nicknameUpdatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      await Promise.race([
        writePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
    } catch (err) {
      if (err?.code === "resource-exhausted") {
        enqueuePending(pendingNicknameKey(authUser.uid), { nickname: trimmed });
        setNicknameError("\uc800\uc7a5\ub7c9/\uc694\uccad \uc81c\ud55c\uc744 \ucd08\uacfc\ud588\uc2b5\ub2c8\ub2e4. \ub85c\uceec\uc5d0 \uc784\uc2dc \uc800\uc7a5\ud588\uace0 \uc790\ub3d9 \uc7ac\uc2dc\ub3c4\ud569\ub2c8\ub2e4.");
      } else if (err?.message === "timeout") {
        enqueuePending(pendingNicknameKey(authUser.uid), { nickname: trimmed });
        setNicknameError("\uc800\uc7a5\uc774 \uc9c0\uc5f0\ub418\uace0 \uc788\uc2b5\ub2c8\ub2e4. \ub85c\uceec\uc5d0 \uc784\uc2dc \uc800\uc7a5\ud588\uace0 \uc790\ub3d9 \uc7ac\uc2dc\ub3c4\ud569\ub2c8\ub2e4.");
      } else {
        setNicknameError("\uc800\uc7a5\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.");
      }
    } finally {
      setNicknameSaving(false);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setAuthUser(user || null);
      setAuthLoading(false);
      setAuthError("");
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authUser) return undefined;
    const retryPending = async () => {
      if (retryInFlightRef.current) return;
      retryInFlightRef.current = true;
      try {
        const nickKey = pendingNicknameKey(authUser.uid);
        const nickRaw = localStorage.getItem(nickKey);
        if (nickRaw) {
          const parsed = JSON.parse(nickRaw);
          const nickname = parsed?.payload?.nickname;
          if (nickname) {
            await setDoc(
              doc(db, "users", authUser.uid),
              { nickname, nicknameUpdatedAt: serverTimestamp() },
              { merge: true }
            );
            localStorage.removeItem(nickKey);
            setNicknameError("");
          }
        }

        const profileKey = pendingProfileKey(authUser.uid);
        const profileRaw = localStorage.getItem(profileKey);
        if (profileRaw) {
          const parsed = JSON.parse(profileRaw);
          const payload = parsed?.payload;
          if (payload) {
            await setDoc(doc(db, "villageProfiles", authUser.uid), payload, { merge: true });
            localStorage.removeItem(profileKey);
          }
        }

        for (const key of ["pendingCommonPrices", "pendingProcessPrices", "pendingMaterialPrices"]) {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          const payload = parsed?.payload;
          if (payload) {
            await setDoc(doc(db, "shared", "prices"), payload, { merge: true });
            localStorage.removeItem(key);
          }
        }
      } catch {
        // keep pending for next retry
      } finally {
        retryInFlightRef.current = false;
      }
    };

    retryPending();
    const timer = setInterval(retryPending, 30000);
    return () => clearInterval(timer);
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setPresenceDocs([]);
      setOnlineUsers([]);
      return undefined;
    }
    if (!presenceEnabled) {
      setPresenceDocs([]);
      setOnlineUsers([]);
      return undefined;
    }
    const ref = doc(db, "presence", authUser.uid);
    const writePresence = async () => {
      const now = Date.now();
      if (now - presenceWriteAtRef.current < PRESENCE_MIN_WRITE_GAP_MS) return;
      presenceWriteAtRef.current = now;
      try {
        await setDoc(
          ref,
          {
            uid: authUser.uid,
            displayName: authUser.displayName || "",
            nickname: userDoc?.nickname || authUser.displayName || "",
            email: authUser.email || "",
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (err) {
        if (err?.code === "resource-exhausted") {
          pausePresence();
        }
      }
    };
    writePresence();
    setPresenceDocs((prev) => {
      const next = Array.isArray(prev) ? [...prev] : [];
      const idx = next.findIndex((u) => u.id === authUser.uid);
      const fallback = {
        id: authUser.uid,
        uid: authUser.uid,
        displayName: authUser.displayName || "",
        nickname: userDoc?.nickname || authUser.displayName || "",
        email: authUser.email || "",
        updatedAt: new Date(),
      };
      if (idx >= 0) next[idx] = { ...next[idx], ...fallback };
      else next.push(fallback);
      return next;
    });
    const timer = setInterval(writePresence, PRESENCE_WRITE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authUser, userDoc, presenceEnabled]);

  useEffect(() => {
    if (!presenceEnabled) {
      setPresenceDocs([]);
      return undefined;
    }
    const unsub = onSnapshot(
      collection(db, "presence"),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setPresenceDocs(rows);
      },
      (err) => {
        if (err?.code === "resource-exhausted") {
          pausePresence();
        }
      }
    );
    return () => unsub();
  }, [presenceEnabled]);

  useEffect(() => {
    if (!presenceEnabled) {
      setOnlineUsers([]);
      return undefined;
    }
    const getUpdatedAtMs = (u) => {
      if (!u?.updatedAt) return null;
      if (typeof u.updatedAt?.toDate === "function") return u.updatedAt.toDate().getTime();
      if (u.updatedAt instanceof Date) return u.updatedAt.getTime();
      if (typeof u.updatedAt === "number") return u.updatedAt;
      return null;
    };
    const update = () => {
      const cutoff = Date.now() - PRESENCE_ONLINE_WINDOW_MS;
      let online = presenceDocs.filter((u) => {
        const ms = getUpdatedAtMs(u);
        return ms != null && ms >= cutoff;
      });
      if (authUser && !online.some((u) => u.id === authUser.uid)) {
        online = [
          ...online,
          {
            id: authUser.uid,
            uid: authUser.uid,
            displayName: authUser.displayName || "",
            nickname: userDoc?.nickname || authUser.displayName || "",
            email: authUser.email || "",
            updatedAt: new Date(),
          },
        ];
      }
      setOnlineUsers(online);
    };
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, [presenceDocs, authUser, userDoc, presenceEnabled]);

  useEffect(() => {
    if (!authUser) {
      setUserDoc(null);
      return undefined;
    }
    const userRef = doc(db, "users", authUser.uid);
    (async () => {
      try {
        const snap = await getDoc(userRef);
        const exists = snap.exists();
        const payload = {
          uid: authUser.uid,
          email: authUser.email || "",
          name: authUser.displayName || "",
          photoURL: authUser.photoURL || "",
          lastLoginAt: serverTimestamp(),
        };
        if (!exists) {
          payload.status = "pending";
          payload.createdAt = serverTimestamp();
        }
        await setDoc(userRef, payload, { merge: true });
      } catch (err) {
        setUserDoc({ uid: authUser.uid, status: "pending" });
        if (err?.code === "resource-exhausted") {
          setAuthError("\ub85c\uadf8\uc778\uc740 \uc131\uacf5\ud588\uc9c0\ub9cc \uc11c\ubc84 \uc5f0\uacb0\uc744 \ud655\uc778\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.");
        }
      }
    })();

    const unsub = onSnapshot(
      userRef,
      (snap) => {
        if (!snap.exists()) {
          setUserDoc({ uid: authUser.uid, status: "pending" });
          return;
        }
        setUserDoc({ id: snap.id, ...snap.data() });
      },
      () => {
        setUserDoc({ uid: authUser.uid, status: "pending" });
      }
    );
    return () => unsub();
  }, [authUser]);

  useEffect(() => {
    if (!authUser || !s.adminMode) {
      setPendingUsers([]);
      return undefined;
    }
    const q = query(collection(db, "users"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => {
        const ta = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
        const tb = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
        return tb - ta;
      });
      setPendingUsers(rows);
    });
    return () => unsub();
  }, [authUser, s.adminMode]);

  useEffect(() => {
    const q = query(collection(db, "villageProfiles"), orderBy("updatedAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setProfiles(rows);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const ref = doc(db, "shared", "prices");
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data();
      const ts = data?.updatedAt?.toDate ? data.updatedAt.toDate() : null;
      const by = data?.updatedBy || null;
      const commonTs = data?.updatedAtCommon?.toDate ? data.updatedAtCommon.toDate() : ts;
      const commonBy = data?.updatedByCommon || by;
      const processTs = data?.updatedAtProcess?.toDate ? data.updatedAtProcess.toDate() : null;
      const processBy = data?.updatedByProcess || null;
      const materialTs = data?.updatedAtMaterial?.toDate ? data.updatedAtMaterial.toDate() : null;
      const materialBy = data?.updatedByMaterial || null;
      setPriceUpdatedAt(ts);
      setPriceUpdatedBy(by);
      setCommonUpdatedAt(commonTs);
      setCommonUpdatedBy(commonBy);
      setProcessUpdatedAt(processTs);
      setProcessUpdatedBy(processBy);
      setMaterialUpdatedAt(materialTs);
      setMaterialUpdatedBy(materialBy);
      if (!data) return;
      suppressPriceWrite.current = true;
      setS((p) => ({
        ...p,
        ingotGrossPrice: data.ingotGrossPrice ?? p.ingotGrossPrice,
        gemGrossPrice: data.gemGrossPrice ?? p.gemGrossPrice,
        prices: data.prices ?? p.prices,
        abilityGrossSell: data.abilityGrossSell ?? p.abilityGrossSell,
        lifeGrossSell: data.lifeGrossSell ?? p.lifeGrossSell,
        potionPrices: data.potionPrices ?? p.potionPrices,
      }));
    });
    return () => unsub();
  }, []);

  const buildUpdater = () => ({
    uid: authUser?.uid || "",
    name: authUser?.displayName || "",
    email: authUser?.email || "",
  });

  const saveCommonPrices = async () => {
    if (!authUser) {
      setCommonPriceError("\ub85c\uadf8\uc778 \ud6c4 \uc800\uc7a5\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4.");
      return;
    }
    setCommonPriceSaving(true);
    setCommonPriceError("");
    const payload = {
      ingotGrossPrice: s.ingotGrossPrice,
      gemGrossPrice: s.gemGrossPrice,
      updatedByCommon: buildUpdater(),
      updatedAtCommon: serverTimestamp(),
    };
    try {
      await Promise.race([
        setDoc(doc(db, "shared", "prices"), payload, { merge: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
    } catch (err) {
      if (err?.code === "resource-exhausted" || err?.message === "timeout") {
        enqueuePending("pendingCommonPrices", payload);
        setCommonPriceError("\uc800\uc7a5 \uc694\uccad\uc774 \ub9ce\uc544 \uc9c0\uc5f0\ub429\ub2c8\ub2e4. \ub85c\uceec\uc5d0 \uc784\uc2dc \uc800\uc7a5\ud588\uace0 \uc790\ub3d9 \uc7ac\uc2dc\ub3c4\ud569\ub2c8\ub2e4.");
      } else {
        setCommonPriceError("\uc800\uc7a5\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.");
      }
    } finally {
      setCommonPriceSaving(false);
    }
  };

  const saveProcessPrices = async () => {
    if (!authUser) {
      setProcessPriceError("\ub85c\uadf8\uc778 \ud6c4 \uc800\uc7a5\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4.");
      return;
    }
    setProcessPriceSaving(true);
    setProcessPriceError("");
    const payload = {
      abilityGrossSell: s.abilityGrossSell,
      lifeGrossSell: s.lifeGrossSell,
      updatedByProcess: buildUpdater(),
      updatedAtProcess: serverTimestamp(),
    };
    try {
      await Promise.race([
        setDoc(doc(db, "shared", "prices"), payload, { merge: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
    } catch (err) {
      if (err?.code === "resource-exhausted" || err?.message === "timeout") {
        enqueuePending("pendingProcessPrices", payload);
        setProcessPriceError("\uc800\uc7a5 \uc694\uccad\uc774 \ub9ce\uc544 \uc9c0\uc5f0\ub429\ub2c8\ub2e4. \ub85c\uceec\uc5d0 \uc784\uc2dc \uc800\uc7a5\ud588\uace0 \uc790\ub3d9 \uc7ac\uc2dc\ub3c4\ud569\ub2c8\ub2e4.");
      } else {
        setProcessPriceError("\uc800\uc7a5\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.");
      }
    } finally {
      setProcessPriceSaving(false);
    }
  };

  const saveMaterialPrices = async () => {
    if (!authUser) {
      setMaterialPriceError("\ub85c\uadf8\uc778 \ud6c4 \uc800\uc7a5\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4.");
      return;
    }
    setMaterialPriceSaving(true);
    setMaterialPriceError("");
    const payload = {
      prices: s.prices,
      modes: s.modes,
      updatedByMaterial: buildUpdater(),
      updatedAtMaterial: serverTimestamp(),
    };
    try {
      await Promise.race([
        setDoc(doc(db, "shared", "prices"), payload, { merge: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
    } catch (err) {
      if (err?.code === "resource-exhausted" || err?.message === "timeout") {
        enqueuePending("pendingMaterialPrices", payload);
        setMaterialPriceError("\uc800\uc7a5 \uc694\uccad\uc774 \ub9ce\uc544 \uc9c0\uc5f0\ub429\ub2c8\ub2e4. \ub85c\uceec\uc5d0 \uc784\uc2dc \uc800\uc7a5\ud588\uace0 \uc790\ub3d9 \uc7ac\uc2dc\ub3c4\ud569\ub2c8\ub2e4.");
      } else {
        setMaterialPriceError("\uc800\uc7a5\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.");
      }
    } finally {
      setMaterialPriceSaving(false);
    }
  };

  const handleLogin = async () => {
    setAuthError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch {
      setAuthError("\uAD6C\uAE00 \uB85C\uADF8\uC778\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694.");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch {
      // ignore
    }
  };

  const openAdminModal = () => {
    setAdminModalOpen(true);
    setAdminPass("");
    setAdminError("");
  };

  const closeAdminModal = () => {
    setAdminModalOpen(false);
    setAdminPass("");
    setAdminError("");
  };

  const loginAdmin = () => {
    if (adminPass === "0327korea") {
      setS((p) => ({ ...p, adminMode: true }));
      closeAdminModal();
      return;
    }
    setAdminError("鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎.");
  };

  const logoutAdmin = () => {
    setS((p) => ({ ...p, adminMode: false }));
  };

  const approveUser = (uid) => {
    if (!s.adminMode) return;
    updateDoc(doc(db, "users", uid), {
      status: "approved",
      approvedAt: serverTimestamp(),
      approvedBy: authUser?.email || "admin",
    });
  };

  const rejectUser = (uid) => {
    if (!s.adminMode) return;
    updateDoc(doc(db, "users", uid), {
      status: "rejected",
      rejectedAt: serverTimestamp(),
      rejectedBy: authUser?.email || "admin",
    });
  };

  const [introOpen, setIntroOpen] = useState(() => {
    try {
      return localStorage.getItem("miner_intro_seen") ? false : true;
    } catch {
      return true;
    }
  });

  const closeIntro = () => {
    try {
      localStorage.setItem("miner_intro_seen", "1");
    } catch {
      // ignore
    }
    setIntroOpen(false);
  };

  // gem expert rule by level: keep raw profile values without normalization
  const setActive = (key) => setS((p) => ({ ...p, activeMenu: key }));
  const isPending = !!authUser && !canUseApp && userDoc?.status !== "rejected";
  const isRejected = userDoc?.status === "rejected";
  const uiLocked = !canUseApp;
  const showSidebar = true;

  return (
    <div
      className="app-root"
      data-theme={s.themeMode}
      style={{
        display: "grid",
        gridTemplateColumns: showSidebar ? "260px 1fr" : "1fr",
        minHeight: "100vh",
        background: "var(--app-bg)",
        color: "var(--text)",
      }}
    >
      {showSidebar ? (
        <div style={{ padding: 16, borderRight: "1px solid var(--soft-border)", background: "var(--panel-bg)" }}>
          <Sidebar
            active={s.activeMenu}
            onSelect={setActive}
            onlineUsers={onlineUsers}
            birthdayMap={birthdayMap}
            calendarInfo={calendarInfo}
            onPrevMonth={() => setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
            onNextMonth={() => setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          />
        </div>
      ) : null}

      <div style={{ padding: 16, background: "var(--app-bg)" }}>
        <div style={{ maxWidth: 1200 }}>
          {authLoading ? (
            <Card title={"\uB85C\uADF8\uC778 \uD655\uC778 \uC911"}>
              <div style={{ fontSize: 13, opacity: 0.8 }}>{"\uB85C\uADF8\uC778 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4."}</div>
            </Card>
          ) : null}

          {authUser && s.adminMode ? (
            <div style={{ marginBottom: 12 }}>
              <Card title={"\uAC00\uC785 \uC2B9\uC778 \uAD00\uB9AC"}>
                {pendingUsers.length === 0 ? (
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {"\uB300\uAE30 \uC911\uC778 \uC694\uCCAD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."}
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {pendingUsers.map((u) => (
                      <div
                        key={u.id}
                        style={{
                          border: "1px solid var(--soft-border)",
                          borderRadius: 12,
                          padding: 12,
                          background: "var(--panel-bg)",
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ fontWeight: 900 }}>
                          {u.name || "-"} ({u.email || "-"})
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {u.createdAt?.toDate ? u.createdAt.toDate().toLocaleString("ko-KR") : "-"}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            onClick={() => approveUser(u.id)}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--input-border)",
                              background: "var(--accent)",
                              color: "var(--accent-text)",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 900,
                            }}
                          >
                            {"\uC2B9\uC778"}
                          </button>
                          <button
                            onClick={() => rejectUser(u.id)}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 10,
                              border: "1px solid var(--input-border)",
                              background: "var(--panel-bg)",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 900,
                            }}
                          >
                            {"\uAC70\uC808"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          ) : null}

          {!authLoading && !canUseApp ? (
            <div style={{ display: "grid", gap: 12, marginBottom: 12 }}>
              {!authUser ? (
                <Card title={"\uB85C\uADF8\uC778 \uD544\uC694"}>
                  <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
                    {"\uB85C\uADF8\uC778\uB41C \uC0AC\uC6A9\uC790\uB9CC \uC2DC\uC138\uC640 \uC635\uC158\uC744 \uBCC0\uACBD\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."}
                  </div>
                  {authError ? <div style={{ fontSize: 12, color: "#c0392b", marginBottom: 8 }}>{authError}</div> : null}
                  <button
                    onClick={handleLogin}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "1px solid var(--input-border)",
                      background: "var(--accent)",
                      color: "var(--accent-text)",
                      cursor: "pointer",
                      fontWeight: 900,
                      fontSize: 13,
                    }}
                  >
                    {"\uAD6C\uAE00\uB85C \uB85C\uADF8\uC778"}
                  </button>
                </Card>
              ) : isRejected ? (
                <Card title={"\uC811\uADFC \uBD88\uAC00"}>
                  <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
                    {"\uC2B9\uC778\uC774 \uAC70\uC808\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uAD00\uB9AC\uC790\uC5D0\uAC8C \uBB38\uC758\uD574\uC8FC\uC138\uC694."}
                  </div>
                  <button
                    onClick={handleLogout}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "1px solid var(--input-border)",
                      background: "var(--panel-bg)",
                      cursor: "pointer",
                      fontWeight: 900,
                      fontSize: 13,
                    }}
                  >
                    {"\uB85C\uADF8\uC544\uC6C3"}
                  </button>
                </Card>
              ) : isPending ? (
                <Card title={"\uC2B9\uC778 \uB300\uAE30"}>
                  <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10 }}>
                    {"\uAD00\uB9AC\uC790 \uC2B9\uC778 \uD6C4 \uC0AC\uC6A9 \uAC00\uB2A5\uD569\uB2C8\uB2E4."}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
                    {"\uB0B4 \uACC4\uC815: "}
                    {authUser.email || "-"}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={handleLogout}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "1px solid var(--input-border)",
                        background: "var(--panel-bg)",
                        cursor: "pointer",
                        fontWeight: 900,
                        fontSize: 13,
                      }}
                    >
                      {"\uB85C\uADF8\uC544\uC6C3"}
                    </button>
                    {!s.adminMode ? (
                      <button
                        onClick={openAdminModal}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 10,
                          border: "1px solid var(--input-border)",
                          background: "var(--panel-bg)",
                          cursor: "pointer",
                          fontWeight: 900,
                          fontSize: 13,
                        }}
                      >
                        {"\uAD00\uB9AC\uC790 \uB85C\uADF8\uC778"}
                      </button>
                    ) : null}
                  </div>
                </Card>
              ) : null}

            </div>
          ) : null}

          <div className={uiLocked ? "readonly-lock" : undefined}>
            {uiLocked ? (
              <div
                style={{
                  marginBottom: 12,
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid #f39c12",
                  background: "rgba(243, 156, 18, 0.12)",
                  fontWeight: 900,
                }}
              >
                {"\uC2DC\uC138/\uC635\uC158 \uBCC0\uACBD\uC740 \uB85C\uADF8\uC778 \uD6C4 \uAC00\uB2A5\uD569\uB2C8\uB2E4. \uB85C\uADF8\uC778 \uD574\uC8FC\uC138\uC694."}
              </div>
            ) : null}
            <div style={{ marginBottom: 14 }}>
              <img
                src="/banner.png"
                alt="\uC131\uBD81\uAD6C \uB9C8\uC744 \uBC30\uB108"
              style={{
                width: "100%",
                height: "min(40vw, 220px)",
                maxHeight: 240,
                objectFit: "contain",
                objectPosition: "center",
                borderRadius: 16,
                border: "1px solid var(--soft-border)",
                background: "var(--panel-bg)",
                display: "block",
              }}
            />
          </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 900 }}>{"\uAD11\uBD80 \uD6A8\uC728 \uACC4\uC0B0\uAE30"}</div>
                  <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
                    {"\uD310\uB9E4 \uC218\uC218\uB8CC "}
              판매 수수료: <b>{fmt(toNum(s.feePct))}%</b>
                    {"% \uC801\uC6A9(\uD310\uB9E4 \uC2E4\uC218\uB839 \uAE30\uC900)"}
                  </div>
                </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={reset}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--panel-bg)",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 12,
                }}
                title="\uc800\uc7a5\ub41c \uc785\ub825\uac12\uc744 \ucd08\uae30\uac12\uc73c\ub85c \ub418\ub3cc\ub9bd\ub2c8\ub2e4."
              >
                {"\ucd08\uae30\ud654"}
              </button>
              {s.adminMode ? (
                <button
                  onClick={logoutAdmin}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--input-border)",
                    background: "var(--panel-bg)",
                    cursor: "pointer",
                    fontWeight: 900,
                    fontSize: 12,
                  }}
                  title="\uad00\ub9ac\uc790 \ub85c\uadf8\uc544\uc6c3"
                >
                  {"\uad00\ub9ac\uc790 \ub85c\uadf8\uc544\uc6c3"}
                </button>
              ) : (
                <button
                  onClick={openAdminModal}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--soft-border)",
                    background: "var(--panel-bg)",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 12,
                    opacity: 0.7,
                  }}
                  title="\uad00\ub9ac\uc790 \ub85c\uadf8\uc778"
                >
                  {"\uad00\ub9ac\uc790"}
                </button>
              )}
              {authUser ? (
                <button
                  onClick={handleLogout}
                  className="unlock-control"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--input-border)",
                    background: "var(--panel-bg)",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                  title={"\uB85C\uADF8\uC544\uC6C3"}
                >
                  {"\uB85C\uADF8\uC544\uC6C3"}
                </button>
              ) : (
                <button
                  onClick={handleLogin}
                  className="unlock-control"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--input-border)",
                    background: "var(--accent)",
                    color: "var(--accent-text)",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                  title={"\uB85C\uADF8\uC778"}
                >
                  {"\uB85C\uADF8\uC778"}
                </button>
              )}
            </div>
          </div>

            <div style={{ marginTop: 14 }}>
            {s.activeMenu === "profile" ? (
              <ProfilePage
                s={s}
                setS={setS}
                feeRate={feeRate}
                priceUpdatedAt={commonUpdatedAt}
                priceUpdatedBy={commonUpdatedBy}
                authUser={authUser}
                userDoc={userDoc}
                onSaveNickname={saveNickname}
                onSaveCommonPrices={saveCommonPrices}
                commonPriceSaving={commonPriceSaving}
                commonPriceError={commonPriceError}
                onSaveMaterialPrices={saveMaterialPrices}
                materialPriceSaving={materialPriceSaving}
                materialPriceError={materialPriceError}
                nicknameSaving={nicknameSaving}
                nicknameError={nicknameError}
              />
            ) : null}
            {s.activeMenu === "potion" ? (
              <PotionPage s={s} setS={setS} feeRate={feeRate} priceUpdatedAt={priceUpdatedAt} />
            ) : null}
            {s.activeMenu === "ingot" ? (
              <IngotPage
                s={s}
                setS={setS}
                feeRate={feeRate}
                priceUpdatedAt={processUpdatedAt}
                priceUpdatedBy={processUpdatedBy}
                onSaveSharedPrices={saveProcessPrices}
                priceSaving={processPriceSaving}
                priceSaveError={processPriceError}
                authUser={authUser}
              />
            ) : null}
            {s.activeMenu === "feedback" ? <FeedbackPage s={s} setS={setS} /> : null}
            {s.activeMenu === "village" ? (
              <VillageSuggestionPage
                s={s}
                onlineUsers={onlineUsers}
                authUser={authUser}
                showProfiles={false}
                profiles={profiles}
                setProfiles={setProfiles}
              />
            ) : null}
            {s.activeMenu === "members" ? (
              <VillageSuggestionPage
                s={s}
                onlineUsers={onlineUsers}
                authUser={authUser}
                showProfiles
                profiles={profiles}
                setProfiles={setProfiles}
              />
            ) : null}
          </div>

            <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
              {"\ub0b4\uc815\ubcf4/\uc2dc\uc138 \ubcc0\uacbd\uc740 \ud3ec\uc158/\uc8fc\uad34 \ud6a8\uc728 \uacc4\uc0b0\uc5d0\ub3c4 \uc790\ub3d9 \ubc18\uc601\ub429\ub2c8\ub2e4. \u00b7 made by mirae24"}
            </div>
          </div>
        </div>
      </div>


      

      {adminModalOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 9999,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "var(--panel-bg)",
              color: "var(--text)",
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 10 }}>
              {"\uad00\ub9ac\uc790 \ub85c\uadf8\uc778"}
            </div>
            <TextField
              label="\ube44\ubc00\ubc88\ud638"
              value={adminPass}
              onChange={(v) => setAdminPass(v)}
              placeholder="\ube44\ubc00\ubc88\ud638 \uc785\ub825"
              type="password"
            />
            {adminError ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "#c0392b" }}>{adminError}</div>
            ) : null}
            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={closeAdminModal}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--panel-bg)",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {"\ucde8\uc18c"}
              </button>
              <button
                onClick={loginAdmin}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--accent)",
                  color: "var(--accent-text)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                {"\ub85c\uadf8\uc778"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {introOpen && canUseApp ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 9999,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "var(--panel-bg)",
              color: "var(--text)",
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 10 }}>
              {"\uc548\ub0b4"}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.9 }}>
              {"\ub2e4\ud06c\ubaa8\ub4dc\ub294 \ub0b4\uc815\ubcf4\uc5d0\uc11c \uc124\uc815\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4."}
              <br />
              {"\ubb38\uc81c\uc810\uc774\ub098 \uac1c\uc120 \uc544\uc774\ub514\uc5b4\ub294 \ubb38\uc758/\ud53c\ub4dc\ubc31\uc5d0 \ub0a8\uaca8\uc8fc\uc138\uc694."}
            </div>
            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={closeIntro}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--input-border)",
                  background: "var(--accent)",
                  color: "var(--accent-text)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                {"\ud655\uc778"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
