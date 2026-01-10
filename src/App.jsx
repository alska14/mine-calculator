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
 * ?レ옄 ?낅젰 ?덉젙?붿슜
 * - ?곹깭??string?쇰줈 ???鍮덇컪/?낅젰以??곹깭 蹂댄샇)
 * - 怨꾩궛???뚮쭔 ?レ옄 蹂??
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

  // v1 -> v2 : prices 援ъ“瑜?{grossSell,buy} -> {market} 濡??뺢퇋??
  if (incomingVer < 2) {
    const oldPrices = s.prices || {};
    const normalized = {};
    for (const [k, v] of Object.entries(oldPrices)) {
      // 湲곗〈 援ъ“硫?grossSell ?곗꽑, ?놁쑝硫?buy, ?놁쑝硫?0
      if (isPlainObject(v)) {
        const market = v.market ?? v.grossSell ?? v.buy ?? 0;
        normalized[k] = { market: String(market ?? "") };
      } else {
        normalized[k] = { market: String(v ?? "") };
      }
    }
    s = { ...s, prices: deepMerge(defaults.prices, normalized) };
  }

  // v2 -> v3 : feedbacks 湲곕낯媛?異붽?
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

  // v3 -> v4 : adminMode 湲곕낯媛?異붽?
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

// ?몄씠吏 怨↔눌??媛뺥솕 ?④퀎蹂?議곌컖 ?쒕엻 ??
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

// 蹂댁꽍 ?꾨Ц媛 ?덈꺼蹂?(?뺣쪧, 媛쒖닔)
function gemExpertRule(level) {
  if (level === 1) return { prob: 0.03, count: 1 };
  if (level === 2) return { prob: 0.07, count: 1 };
  if (level === 3) return { prob: 0.10, count: 2 };
  return { prob: 0, count: 0 };
}

// 遺덈텤? 怨↔눌???덈꺼蹂?(?뺣쪧, 二쇨눼 1媛?吏곷뱶??
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
 * - 蹂댁꽍 ?쒕엻 ?먯젙(蹂댁꽍 ?꾨Ц媛)? 遺덈텤????좊룄 洹몃?濡??좎?
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
 * - ?먮ℓ ?쒖뿉???섏닔猷?諛섏쁺(?ㅼ닔??
 * - 援щℓ 鍮꾩슜? market 洹몃?濡??섏닔猷??놁쓬)
 */
function unitCostByMode({ mode, marketPrice, feeRate }) {
  if (mode === "owned") return 0;
  if (mode === "buy") return Math.max(0, marketPrice); // 援щℓ 鍮꾩슜 = ?쒖옣媛(?섏닔猷??놁쓬)
  // opportunity(湲고쉶鍮꾩슜) = ?대떦 ?щ즺瑜??붿븯????諛쏅뒗 ?ㅼ닔?뱀쓣 ?ш린??媛?
  return netSell(Math.max(0, marketPrice), feeRate);
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

  activeMenu: "potion", // potion | ingot | profile | feedback | village
  feePct: "5",
  themeMode: "light", // light | dark

  // ?댁젙蹂?
  sageEnhLevel: 15, // 5~15
  gemExpertLevel: 3, // 0~3
  flamingPickLevel: 0, // 0~10
  staminaPerDig: "10",
  shardsPerIngot: "16",

  // ?쒖꽭(?쒖옣媛, gross)
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

  // ?쒖옉/?먮ℓ媛 (gross)
  abilityGrossSell: "18000",
  lifeGrossSell: {
    low: "9000", // ?섍툒
    mid: "30000", // 以묎툒
    high: "60000", // ?곴툒
  },

  // ?щ즺 ?쒖꽭(媛쒕떦, ?쒖옣媛 1媛쒕쭔)
  prices: {
    ingot: { market: "6000" },
    stone: { market: "773" }, // ?뚮춬移??섍툒)
    deepCobble: { market: "281" }, // ?ъ링??議곗빟??萸됱튂(以묎툒)
    redstone: { market: "97" },
    copper: { market: "100" },
    diamond: { market: "2900" },
    iron: { market: "700" },
    lapis: { market: "100" },
    gold: { market: "570" },
    amethyst: { market: "78" },
  },

  // ?щ즺 泥섎━ 諛⑹떇(吏곸젒?섍툒/援щℓ/怨좉툒:?ш린???먮ℓ?섏씡)
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

function Sidebar({ active, onSelect, onlineUsers }) {
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
      <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 6 }}>硫붾돱</div>
      <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
        {"\ub2e4\ud06c\ubaa8\ub4dc\ub294 \ub0b4\uc815\ubcf4\uc5d0\uc11c \uc124\uc815\ud560 \uc218 \uc788\uace0, \ubb38\uc81c\uc810\uc740 \ubb38\uc758/\ud53c\ub4dc\ubc31\uc5d0 \ub0a8\uaca8\uc8fc\uc138\uc694."}
      </div>
      <div style={{ marginTop: 8, paddingTop: 10, borderTop: "1px solid var(--soft-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 900 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2ecc71", boxShadow: "0 0 6px rgba(46, 204, 113, 0.8)", display: "inline-block" }} />
          {`온라인 ${onlineUsers.length}명`}
        </div>
        {onlineUsers.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>접속 중인 사용자가 없습니다.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {onlineUsers.map((user) => (
              <div key={user.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2ecc71", display: "inline-block" }} />
                <span>{user.displayName || user.email || "익명"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={itemStyle("potion")} onClick={() => onSelect("potion")}>
        ?ㅽ뀒誘몃굹 ?ъ뀡 ?⑥쑉 怨꾩궛
      </div>
      <div style={itemStyle("ingot")} onClick={() => onSelect("ingot")}>
        二쇨눼/媛怨?鍮꾧탳
      </div>
      <div style={itemStyle("profile")} onClick={() => onSelect("profile")}>
        ?댁젙蹂?+ ?쒖꽭 ?낅젰
      </div>
      <div style={itemStyle("feedback")} onClick={() => onSelect("feedback")}>
        臾몄쓽/?쇰뱶諛?
      </div>
      <div style={itemStyle("village")} onClick={() => onSelect("village")}>
        留덉쓣 嫄댁쓽??
      </div>
      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.75, lineHeight: 1.4 }}>
        ?낅젰媛믪? 釉뚮씪?곗????먮룞 ??λ맗?덈떎.
      </div>
    </div>
  );
}

/**
 * =======================
 * Pages
 * =======================
 */

function ProfilePage({ s, setS, feeRate, priceUpdatedAt }) {
  const sageOptions = useMemo(() => {
    const values = Object.keys(SAGE_SHARDS_BY_ENH).map(Number).sort((a, b) => a - b);
    return values.map((v) => ({ value: v, label: `${v}媛?(議곌컖 ${SAGE_SHARDS_BY_ENH[v]}媛?` }));
  }, []);

  const gemOptions = [
    { value: 0, label: "0?덈꺼 (?ㅽ궗 ?놁쓬)" },
    { value: 1, label: "1?덈꺼 (3% ?뺣쪧, 1媛?" },
    { value: 2, label: "2?덈꺼 (7% ?뺣쪧, 1媛?" },
    { value: 3, label: "3?덈꺼 (10% ?뺣쪧, 2媛?" },
  ];

  const flameOptions = [
    { value: 0, label: "0?덈꺼 (?ㅽ궗 ?놁쓬)" },
    ...Array.from({ length: 9 }, (_, i) => {
      const lv = i + 1;
      return { value: lv, label: `${lv}?덈꺼 (${lv}% ?뺣쪧, 議곌컖?믪＜愿?1媛??泥?` };
    }),
    { value: 10, label: "10?덈꺼 (15% ?뺣쪧, 議곌컖?믪＜愿?1媛??泥?" },
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
      <Card title="???뺣낫 ?낅젰">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
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
            label="?몄씠吏 怨↔눌??媛뺥솕 ?④퀎"
            value={s.sageEnhLevel}
            onChange={(v) => setS((p) => ({ ...p, sageEnhLevel: v }))}
            options={sageOptions}
          />
          <Select
            label="蹂댁꽍 ?꾨Ц媛 ?덈꺼"
            value={s.gemExpertLevel}
            onChange={(v) => setS((p) => ({ ...p, gemExpertLevel: v }))}
            options={gemOptions}
          />
          <Select
            label="遺덈텤? 怨↔눌???덈꺼"
            value={s.flamingPickLevel}
            onChange={(v) => setS((p) => ({ ...p, flamingPickLevel: v }))}
            options={flameOptions}
          />
          <Field
            label="愿묒쭏 1???ㅽ깭誘몃굹"
            value={s.staminaPerDig}
            onChange={(v) => setS((p) => ({ ...p, staminaPerDig: v }))}
            placeholder="?? 10"
            min={1}
          />
          <Field
            label="議곌컖?믪＜愿??꾩슂 議곌컖"
            value={s.shardsPerIngot}
            onChange={(v) => setS((p) => ({ ...p, shardsPerIngot: v }))}
            placeholder="?? 16"
            min={1}
          />
        </div>

        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "var(--soft-bg)", border: "1px solid var(--soft-border)" }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>?꾩옱 ?댁젙蹂??붿빟</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13 }}>
            <div>
              議곌컖/??遺덈텤? 誘몃컻????: <b>{fmt(shardsPerDig)}</b>
            </div>
            <div>
              蹂댁꽍: <b>{fmt(gemRule.prob * 100)}%</b>, <b>{fmt(gemRule.count)}</b>媛?
            </div>
            <div>
              遺덈텤?(?泥?: <b>{fmt(flameRule.prob * 100)}%</b> ?뺣쪧, <b>二쇨눼 1媛?</b>)</div>
            <div>
              ?먮ℓ ?섏닔猷? <b>{fmt(toNum(s.feePct))}%</b>
            </div>
          </div>
        </div>
      </Card>

      <Card title="?쒖꽭 ?낅젰 (怨듯넻)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <Field
            label="?먮ℓ ?섏닔猷?%)"
            value={s.feePct}
            onChange={(v) => setS((p) => ({ ...p, feePct: v }))}
            placeholder="?? 5"
            min={0}
            max={50}
            suffix="%"
          />
          <Field
            label="二쇨눼 ?쒖옣媛(??"
            value={s.ingotGrossPrice}
            onChange={(v) =>
              setS((p) => ({
                ...p,
                ingotGrossPrice: v,
                prices: { ...p.prices, ingot: { market: v } },
              }))
            }
            placeholder="?? 6000"
            min={0}
            suffix="?"
          />
          <Field
            label="蹂댁꽍 ?쒖옣媛(??"
            value={s.gemGrossPrice}
            onChange={(v) => setS((p) => ({ ...p, gemGrossPrice: v }))}
            placeholder="?? 12000"
            min={0}
            suffix="?"
          />
        </div>

        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          ?먮ℓ ?ㅼ닔???섏닔猷?諛섏쁺):
          <br />- 二쇨눼 {fmt(toNum(s.ingotGrossPrice))} ??<b>{fmt(netSell(toNum(s.ingotGrossPrice), feeRate))}</b>??
          <br />- 蹂댁꽍 {fmt(toNum(s.gemGrossPrice))} ??<b>{fmt(netSell(toNum(s.gemGrossPrice), feeRate))}</b>??
          <br />
          援щℓ 鍮꾩슜(?섏닔猷??놁쓬): <b>?쒖옣媛 洹몃?濡?</b>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {"\ucd5c\uadfc \uc2dc\uc138 \uc5c5\ub370\uc774\ud2b8: "}
          {priceUpdatedAt ? priceUpdatedAt.toLocaleString("ko-KR") : "-"}
        </div>
      </Card>

      <Card title="?щ즺 ?쒖꽭(?쒖옣媛) + ?섍툒 諛⑹떇 ?낅젰">
        <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 10, lineHeight: 1.5 }}>
          ?щ즺??<b>?쒖옣媛 1媛쒕쭔</b> ?낅젰?⑸땲??
          <br />- ?먮ℓ ?ㅼ닔??= ?쒖옣媛 횞 (1-?섏닔猷?
          <br />- 援щℓ 鍮꾩슜 = ?쒖옣媛(?섏닔猷??놁쓬)
          <br />
          ?섍툒 諛⑹떇:
          <br />- 吏곸젒 ?섍툒(0) / 援щℓ ?꾩슂 / (怨좉툒) ?ш린???먮ℓ ?섏씡
        </div>
        <div style={{ marginBottom: 12 }}>
          <Select
            label={"\uc218\uae09 \ubc29\uc2dd \uc77c\uad04 \uc124\uc815"}
            value="custom"
            onChange={(v) => {
              if (v === "custom") return;
              const mode = v === "all_buy" ? "buy" : "owned";
              setS((p) => ({
                ...p,
                modes: materialKeysForUI.reduce((acc, key) => ({ ...acc, [key]: mode }), { ...p.modes }),
              }));
            }}
            options={[
              { value: "custom", label: "\ucee4\uc2a4\ud140(\uac1c\ubcc4 \uc124\uc815)" },
              { value: "all_owned", label: "\uc804\ubd80 \uc9c1\uc811 \uc218\uae09" },
              { value: "all_buy", label: "\uc804\ubd80 \uad6c\ub9e4" },
            ]}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          {materialKeysForUI.map((k) => (
            <React.Fragment key={k}>
              <Field
                label={`${materialLabels[k] ?? k} \uc2dc\uc7a5\uac00(\uac1c\ub2f9)`}
                value={s.prices[k]?.market ?? ""}
                onChange={(v) => setS((p) => ({ ...p, prices: { ...p.prices, [k]: { market: v } } }))}
                min={0}
                suffix="?"
              />
              <Select
                label={`${materialLabels[k] ?? k} \uc218\uae09 \ubc29\uc2dd`}
                value={
                  ["owned", "opportunity", "buy"].includes(s.modes[k])
                    ? s.modes[k] === "owned"
                      ? 0
                      : s.modes[k] === "buy"
                        ? 1
                        : 2
                    : 0
                }
                onChange={(v) => {
                  const mode = v === 0 ? "owned" : v === 1 ? "buy" : "opportunity";
                  setS((p) => ({ ...p, modes: { ...p.modes, [k]: mode } }));
                }}
                options={[
                  { value: 0, label: "吏곸젒 ?섍툒(0)" },
                  { value: 1, label: "援щℓ ?꾩슂" },
                  { value: 2, label: "?ш린???먮ℓ ?섏씡(怨좉툒)" },
                ]}
              />
            </React.Fragment>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {"\ucd5c\uadfc \uc2dc\uc138 \uc5c5\ub370\uc774\ud2b8: "}
          {priceUpdatedAt ? priceUpdatedAt.toLocaleString("ko-KR") : "-"}
        </div>
      </Card>
    </div>
  );
}

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
    if (type === "bug") return "?ㅻ쪟/?섎せ????";
    if (type === "other") return "湲고?";
    return "媛쒖꽑";
  };

  const statusLabel = (status) => {
    if (status === "progress") return "吏꾪뻾以?";
    if (status === "done") return "?꾨즺";
    return "?묒닔";
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="媛쒖꽑???ㅻ쪟 ?쒕낫">
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
          ?ъ슜 以?臾몄젣?먯씠??媛쒖꽑 ?꾩씠?붿뼱媛 ?덉쑝硫?臾몄쓽/?쇰뱶諛깆뿉 ?④꺼二쇱꽭??
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>?좏삎</div>
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
              <option value="improve">媛쒖꽑</option>
              <option value="bug">?ㅻ쪟/?섎せ????</option>
              <option value="other">湲고?</option>
            </select>
          </div>
          <TextField
            label="?곕씫泥??좏깮)"
            value={form.contact}
            onChange={(v) => setForm((p) => ({ ...p, contact: v }))}
            placeholder="?대찓???붿뒪肄붾뱶 ??"
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 12 }}>
          <Select
            label={"怨듦컻 ?ㅼ젙"}
            value={form.visibility}
            onChange={(v) => setForm((p) => ({ ...p, visibility: v }))}
            options={[
              { value: "public", label: "怨듦컻" },
              { value: "private", label: "鍮꾧났媛?愿由ъ옄留?" },
            ]}
          />
          <TextField
            label="?쒕ぉ"
            value={form.title}
            onChange={(v) => setForm((p) => ({ ...p, title: v }))}
            placeholder="?? ?щ즺 ?쒖꽭 ?낅젰??遺덊렪?댁슂"
          />
          <TextArea
            label="?댁슜"
            value={form.body}
            onChange={(v) => setForm((p) => ({ ...p, body: v }))}
            placeholder="?대뼡 臾몄젣媛 ?덉뿀?붿?, 媛쒖꽑 ?꾩씠?붿뼱瑜??먯꽭???곸뼱二쇱꽭??"
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
            ?쒕낫 ?깅줉
          </button>
        </div>
      </Card>

      <Card title="臾몄쓽 愿由">
        {items.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>?깅줉??臾몄쓽媛 ?놁뒿?덈떎.</div>
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
                  <div style={{ fontSize: 12, opacity: 0.8 }}>?곕씫泥? {item.contact}</div>
                ) : null}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    怨듦컻: {item.visibility === "private" ? "鍮꾧났媛?" : "怨듦컻"}
                  </div>
                  {item.reply ? (
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>愿由ъ옄 ?듬? ?꾨즺</div>
                  ) : null}
                </div>
                {item.reply ? (
                  <div style={{ padding: 10, borderRadius: 10, background: "var(--soft-bg)", border: "1px solid var(--soft-border)", fontSize: 13 }}>
                    <div style={{ fontWeight: 900, marginBottom: 4 }}>愿由ъ옄 ?듬?</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{item.reply}</div>
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>?곹깭</div>
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
                      <option value="new">?묒닔</option>
                      <option value="progress">吏꾪뻾以?</option>
                      <option value="done">?꾨즺</option>
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
                      ??젣
                    </button>
                  ) : null}
                </div>
                {isAdmin ? (
                  <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
                    <TextArea
                      label="愿由ъ옄 ?듬?"
                      value={replyDrafts[item.id] ?? ""}
                      onChange={(v) => setReplyDrafts((p) => ({ ...p, [item.id]: v }))}
                      placeholder="?듬????낅젰?섏꽭??"
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
                        ?듬? ???
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

function VillageSuggestionPage({ s }) {
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
    const finalType = form.type === "other" ? customType.trim() || "湲고?" : form.type;
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

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title={"\ub9c8\uc744 \uac74\uc758\ud568"}>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
          {"\ub9c8\uc744 \uad00\ub828 \uac74\uc758/\ubb38\uc758\ub294 \uc5ec\uae30\uc5d0 \ub0a8\uaca8\uc8fc\uc138\uc694."}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>?좏삎</div>
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
              <option value="improve">媛쒖꽑</option>
              <option value="bug">?ㅻ쪟/?섎せ????</option>
              <option value="other">湲고?(吏곸젒 ?낅젰)</option>
            </select>
          </div>
          <TextField
            label="?곕씫泥??좏깮)"
            value={form.contact}
            onChange={(v) => setForm((p) => ({ ...p, contact: v }))}
            placeholder="?대찓???붿뒪肄붾뱶 ??"
          />
        </div>

        {form.type === "other" ? (
          <div style={{ marginTop: 12 }}>
            <TextField
              label="湲고? ?좏삎"
              value={customType}
              onChange={(v) => setCustomType(v)}
              placeholder="?? ?대깽???쒖꽕/?곸젏"
            />
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 12 }}>
          <Select
            label={"怨듦컻 ?ㅼ젙"}
            value={form.visibility}
            onChange={(v) => setForm((p) => ({ ...p, visibility: v }))}
            options={[
              { value: "public", label: "怨듦컻" },
              { value: "private", label: "鍮꾧났媛?愿由ъ옄留?" },
            ]}
          />
          <TextField
            label="?쒕ぉ"
            value={form.title}
            onChange={(v) => setForm((p) => ({ ...p, title: v }))}
            placeholder="?? 留덉쓣 ?곸젏???꾩씠??異붽? ?붿껌"
          />
          <TextArea
            label="?댁슜"
            value={form.body}
            onChange={(v) => setForm((p) => ({ ...p, body: v }))}
            placeholder="嫄댁쓽 ?댁슜???먯꽭???곸뼱二쇱꽭??"
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
            ?깅줉
          </button>
        </div>
      </Card>

      <Card title={"\uac74\uc758 \uad00\ub9ac"}>
        {items.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.8 }}>?깅줉??嫄댁쓽媛 ?놁뒿?덈떎.</div>
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
                  <div style={{ fontSize: 12, opacity: 0.8 }}>?곕씫泥? {item.contact}</div>
                ) : null}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    怨듦컻: {item.visibility === "private" ? "鍮꾧났媛?" : "怨듦컻"}
                  </div>
                  {item.reply ? (
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>
                      愿由ъ옄 ?듬? ?꾨즺
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
                    <div style={{ fontWeight: 900, marginBottom: 4 }}>愿由ъ옄 ?듬?</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{item.reply}</div>
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>?곹깭</div>
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
                      <option value="new">?묒닔</option>
                      <option value="progress">吏꾪뻾以?</option>
                      <option value="done">?꾨즺</option>
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
                      ??젣
                    </button>
                  ) : null}
                </div>
                {isAdmin ? (
                  <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
                    <TextArea
                      label="愿由ъ옄 ?듬?"
                      value={replyDrafts[item.id] ?? ""}
                      onChange={(v) => setReplyDrafts((p) => ({ ...p, [item.id]: v }))}
                      placeholder="?듬????낅젰?섏꽭??"
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
                        ?듬? ???
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

function PotionRowDetails({ feeRate, ev, row, shardsPerDig, gemRule, flameRule }) {
  const stamina = row.stamina;
  const spd = ev.staminaPerDig;
  const digs = stamina / spd;

  const ingotFromShardsValue = ev.ingotFromShardsValuePerDig * digs;
  const ingotFromFlameValue = ev.ingotFromFlameValuePerDig * digs;
  const gemValue = ev.gemValuePerDig * digs;

  const total = ingotFromShardsValue + ingotFromFlameValue + gemValue;

  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 12, background: "var(--panel-bg)", border: "1px solid var(--soft-border)" }}>
      <div style={{ fontWeight: 900, marginBottom: 8 }}>?몃??댁뿭: {row.label}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, fontSize: 13 }}>
        <div>湲곗? ?ㅽ깭誘몃굹</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(stamina)}</div>

        <div>愿묒쭏 1???ㅽ깭誘몃굹</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(spd)}</div>

        <div>?덉긽 愿묒쭏 ?잛닔(?ㅽ깭誘몃굹/??</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{digs.toFixed(4)}??</div>

        <div>二쇨눼 ?ㅼ닔???④?</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.ingotNet)}??</div>

        <div>蹂댁꽍 ?ㅼ닔???④?</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.gemNet)}??</div>

        <div>遺덈텤? ?뺣쪧 p(?泥?</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{(ev.pFlame * 100).toFixed(2)}%</div>

        <div>?뚮떦 議곌컖(遺덈텤? 誘몃컻????</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(shardsPerDig)}媛?</div>

        <div>蹂댁꽍 ?꾨Ц媛</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>
          {fmt(gemRule.prob * 100)}% / {fmt(gemRule.count)}媛?
        </div>

        <div>遺덈텤?</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(flameRule.prob * 100)}% / 二쇨눼 1媛?議곌컖 0 ?泥?</div>

        <div style={{ marginTop: 6, fontWeight: 900 }}>?ъ뀡 ?ㅽ깭誘몃굹 湲곗? 湲곕?留ㅼ텧(?ㅼ닔?? 遺꾪빐</div>
        <div />

        <div>議곌컖?믪＜愿?湲곕?媛移?</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ingotFromShardsValue)}??</div>

        <div>遺덈텤?(?泥? 二쇨눼 湲곕?媛移?</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ingotFromFlameValue)}??</div>

        <div>蹂댁꽍 湲곕?媛移?遺덈텤?怨?臾닿?)</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(gemValue)}??</div>

        <div>?⑷퀎 湲곕?留ㅼ텧(?ㅼ닔??</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(total)}??</div>

        <div>援щℓ媛</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(row.cost)}??</div>

        <div>?쒖씠??</div>
        <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(total - row.cost)}??</div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
        怨꾩궛???붿빟(遺덈텤?=?泥?:
        <br />- ?뚮떦 二쇨눼 湲곕???= <b>(1-p)횞(議곌컖/?꾩슂議곌컖)</b> + <b>p횞1</b>
        <br />- ?뚮떦 蹂댁꽍 湲곕?媛移?= (蹂댁꽍?뺣쪧 횞 蹂댁꽍媛쒖닔 횞 蹂댁꽍?ㅼ닔?밸떒媛) <b>(遺덈텤?怨?臾닿?)</b>
        <br />- ?ъ뀡 湲곗? 湲곕?留ㅼ텧 = (?뚮떦 湲곕?媛移? 횞 (?ㅽ깭誘몃굹 / 愿묒쭏1?뚯뒪?쒕???
      </div>
    </div>
  );
}

function PotionPage({ s, setS, feeRate, priceUpdatedAt }) {
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

  const results = useMemo(() => {
    const p = s.potionPrices;
    const rows = [
      { key: "p100", label: "100 ?ъ뀡", stamina: 100, cost: toNum(p.p100) },
      { key: "p300", label: "300 ?ъ뀡", stamina: 300, cost: toNum(p.p300) },
      { key: "p500", label: "500 ?ъ뀡", stamina: 500, cost: toNum(p.p500) },
      { key: "p700", label: "700 ?ъ뀡", stamina: 700, cost: toNum(p.p700) },
    ].map((r) => {
      const revenue = ev.totalPerStamina * r.stamina;
      const profit = revenue - r.cost;
      return { ...r, revenue, profit };
    });
    const best = rows.reduce((acc, cur) => (cur.profit > acc.profit ? cur : acc), rows[0]);
    return { rows, best };
  }, [s.potionPrices, ev.totalPerStamina]);

  const toggleRow = (key) => {
    setS((p) => ({
      ...p,
      potionRowDetailsOpen: {
        ...p.potionRowDetailsOpen,
        [key]: !p.potionRowDetailsOpen?.[key],
      },
    }));
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="?ㅽ뀒誘몃굹 ?ъ뀡 ?⑥쑉 怨꾩궛">
        <div style={{ marginTop: 10, padding: 12, borderRadius: 12, background: "var(--soft-bg)", border: "1px solid var(--soft-border)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13 }}>
            <div>議곌컖/??誘몃컻????: <b>{fmt(shardsPerDig)}</b></div>
            <div>蹂댁꽍: <b>{fmt(gemRule.prob * 100)}%</b>, <b>{fmt(gemRule.count)}</b>媛?</div>
            <div>遺덈텤?(?泥?: <b>{fmt(flameRule.prob * 100)}%</b> (二쇨눼 1媛??)</div>
            <div>?ㅽ깭誘몃굹 1??湲곕? ?섏씡(?ㅼ닔??: <b>{fmt(ev.totalPerStamina)}</b>??</div>
          </div>
        </div>
      </Card>

      <Card title="?ъ뀡 媛寃??낅젰">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <Field label="100 ?ъ뀡 媛寃?" value={s.potionPrices.p100} onChange={(v) => setS((p) => ({ ...p, potionPrices: { ...p.potionPrices, p100: v } }))} min={0} suffix="?" />
          <Field label="300 ?ъ뀡 媛寃?" value={s.potionPrices.p300} onChange={(v) => setS((p) => ({ ...p, potionPrices: { ...p.potionPrices, p300: v } }))} min={0} suffix="?" />
          <Field label="500 ?ъ뀡 媛寃?" value={s.potionPrices.p500} onChange={(v) => setS((p) => ({ ...p, potionPrices: { ...p.potionPrices, p500: v } }))} min={0} suffix="?" />
          <Field label="700 ?ъ뀡 媛寃?" value={s.potionPrices.p700} onChange={(v) => setS((p) => ({ ...p, potionPrices: { ...p.potionPrices, p700: v } }))} min={0} suffix="?" />
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {"\ucd5c\uadfc \uc2dc\uc138 \uc5c5\ub370\uc774\ud2b8: "}
          {priceUpdatedAt ? priceUpdatedAt.toLocaleString("ko-KR") : "-"}
        </div>
      </Card>

      <Card title="寃곌낵 (?쒖씠??湲곗?) ???ъ뀡蹂??몃??댁뿭 ?쇱튂湲?">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?ъ뀡</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?ㅽ깭誘몃굹</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>湲곕?留ㅼ텧(?ㅼ닔??</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>援щℓ媛</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?쒖씠??</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?몃?</th>
              </tr>
            </thead>
            <tbody>
              {results.rows.map((r) => {
                const open = !!s.potionRowDetailsOpen?.[r.key];
                return (
                  <React.Fragment key={r.key}>
                    <tr>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>{r.label}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>{fmt(r.stamina)}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>{fmt(r.revenue)}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>{fmt(r.cost)}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right", fontWeight: 900 }}>{fmt(r.profit)}</td>
                      <td style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)", textAlign: "right" }}>
                        <ToggleButton isOn={open} onClick={() => toggleRow(r.key)} labelOn="?リ린" labelOff="蹂닿린" />
                      </td>
                    </tr>
                    {open ? (
                      <tr>
                        <td colSpan={6} style={{ padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>
                          <PotionRowDetails
                            feeRate={feeRate}
                            ev={ev}
                            row={r}
                            shardsPerDig={shardsPerDig}
                            gemRule={gemRule}
                            flameRule={flameRule}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10, padding: 12, borderRadius: 12, background: "var(--soft-bg)", border: "1px solid var(--soft-border)" }}>
          ?쒖씠??異붿쿇: <b>{results.best.label}</b>
        </div>
      </Card>
    </div>
  );
}

function IngotPage({ s, setS, feeRate, priceUpdatedAt }) {
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

  // ?댁젙蹂?湲곕컲 湲곕?媛?二쇨눼/蹂댁꽍)
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

  // 鍮꾧탳 怨꾩궛(?쒖옉 vs ?щ즺?먮ℓ)
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

  // ?먯꽭?덈낫湲??ш린???먮ℓ ?섏씡) ?좉?: ?붾㈃??蹂듭옟?섍쾶 留뚮뱾吏 ?딄린 ?꾪빐 ?ш린留???
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
      <Card title="二쇨눼/蹂댁꽍 湲곕?媛?(?댁젙蹂?湲곕컲)">
        <div style={{ marginBottom: 10, fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          ?꾨옒 湲곕?媛믪? 紐⑤몢 <b>?ㅼ닔??湲곗?</b>?낅땲?? (?먮ℓ ?섏닔猷?{fmt(toNum(s.feePct))}% 諛섏쁺)
        </div>

        <div style={{ padding: 12, borderRadius: 12, background: "var(--soft-bg)", border: "1px solid var(--soft-border)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, fontSize: 13 }}>
            <div>?뚮떦 議곌컖(誘몃컻????</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(shardsPerDig)}媛?</div>
            <div>遺덈텤? ?뺣쪧 p(?泥?</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(flameRule.prob * 100)}%</div>
            <div>?뚮떦 二쇨눼(議곌컖?믫솚?? 湲곕?</div><div style={{ textAlign: "right", fontWeight: 900 }}>{ev.ingotFromShardsPerDig.toFixed(4)}媛?</div>
            <div>?뚮떦 二쇨눼(遺덈텤? ?泥? 湲곕?</div><div style={{ textAlign: "right", fontWeight: 900 }}>{ev.ingotFromFlamePerDig.toFixed(4)}媛?</div>
            <div>?뚮떦 蹂댁꽍 湲곕?媛移?</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.gemValuePerDig)}??</div>
            <div>?뚮떦 珥?湲곕?媛移?</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.totalPerDig)}??</div>
            <div>?ㅽ깭誘몃굹 1??湲곕?媛移?</div><div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ev.totalPerStamina)}??</div>
          </div>
        </div>
      </Card>

      <Card title="媛怨?鍮꾧탳: ?щ즺 洹몃?濡??먮ℓ vs ?대퉴/?쇱씠?꾩뒪??">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <Field
            label="?대퉴由ы떚 ?ㅽ넠 ?먮ℓ媛(?쒖옣媛)"
            value={s.abilityGrossSell}
            onChange={(v) => setS((p) => ({ ...p, abilityGrossSell: v }))}
          />
          <Field
            label="?섍툒 ?쇱씠?꾩뒪???먮ℓ媛(?쒖옣媛)"
            value={s.lifeGrossSell.low}
            onChange={(v) => setS((p) => ({ ...p, lifeGrossSell: { ...p.lifeGrossSell, low: v } }))}
          />
          <Field
            label="以묎툒 ?쇱씠?꾩뒪???먮ℓ媛(?쒖옣媛)"
            value={s.lifeGrossSell.mid}
            onChange={(v) => setS((p) => ({ ...p, lifeGrossSell: { ...p.lifeGrossSell, mid: v } }))}
          />
          <Field
            label="?곴툒 ?쇱씠?꾩뒪???먮ℓ媛(?쒖옣媛)"
            value={s.lifeGrossSell.high}
            onChange={(v) => setS((p) => ({ ...p, lifeGrossSell: { ...p.lifeGrossSell, high: v } }))}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {"\ucd5c\uadfc \uc2dc\uc138 \uc5c5\ub370\uc774\ud2b8: "}
          {priceUpdatedAt ? priceUpdatedAt.toLocaleString("ko-KR") : "-"}
        </div>

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          ?쒖쓽 ?섎?:
          <br />- <b>?щ즺 洹몃?濡??먮ℓ ?ㅼ닔??</b>: 媛숈? ?щ즺瑜?洹몃깷 ?붿븯????湲곗???
          <br />- <b>?쒖옉 ?먮ℓ ?ㅼ닔??</b>: 寃곌낵臾쇱쓣 留뚮뱾???붿븯????
          <br />- <b>?쒖옉 ?쒖씠??</b>: ?좏깮???섍툒 諛⑹떇(吏곸젒?섍툒/援щℓ/?ш린???먮ℓ?섏씡)???곕Ⅸ ?쒗쁽?????곹솴 湲곗???寃곌낵
        </div>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>??ぉ</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?쒖옉 ?먮ℓ ?ㅼ닔??</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?ъ슜???щ즺 媛移??좏깮 湲곗?)</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>?쒖옉 ?쒖씠??</th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>
                  ?щ즺 洹몃?濡??먮ℓ ?ㅼ닔??援щℓ ?쒖쇅)
                </th>
                <th style={{ textAlign: "right", padding: "8px 6px", borderBottom: "1px solid var(--soft-border)" }}>異붿쿇</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: "?대퉴由ы떚 ?ㅽ넠", key: "ability" },
                { name: "?섍툒 ?쇱씠?꾩뒪??", key: "low" },
                { name: "以묎툒 ?쇱씠?꾩뒪??", key: "mid" },
                { name: "?곴툒 ?쇱씠?꾩뒪??", key: "high" },
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
                      {x.profit - x.sellIndivNet >= 0 ? "?쒖옉 ?대뱷" : "?щ즺 ?먮ℓ ?대뱷"}
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
            labelOn="?먯꽭?덈낫湲??リ린"
            labelOff="?먯꽭?덈낫湲??ш린???먮ℓ ?섏씡)"
          />
        </div>

        {detailOpen ? (
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {[
              { name: "?대퉴由ы떚 ?ㅽ넠", key: "ability" },
              { name: "?섍툒 ?쇱씠?꾩뒪??", key: "low" },
              { name: "以묎툒 ?쇱씠?꾩뒪??", key: "mid" },
              { name: "?곴툒 ?쇱씠?꾩뒪??", key: "high" },
            ].map((row) => {
              const x = compare[row.key];
              const ex = explain(x);
              return (
                <div key={row.key} style={{ padding: 12, borderRadius: 12, border: "1px solid var(--soft-border)", background: "var(--panel-bg)" }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{row.name} ??鍮꾩슜 遺꾪빐(?좏깮 湲곗?)</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, fontSize: 13 }}>
                    <div>援щℓ濡??섍컙 ???ㅼ?異?</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ex.buySpend)}??</div>
                    <div>?ш린???먮ℓ ?섏씡(湲고쉶鍮꾩슜)</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ex.foregone)}??</div>
                    <div>吏곸젒 ?섍툒 ?щ즺 ?섎웾 ??</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{fmt(ex.ownedQty)}媛?</div>
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
  // ?ㅻ? v4->v6濡?蹂寃??댁쟾 媛?異⑸룎 理쒖냼?? + 留덉씠洹몃젅?댁뀡?쇰줈 ?≪닔
  const [s, setS] = useLocalStorageState("miner_eff_v6", defaultState);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [adminError, setAdminError] = useState("");
  const [priceUpdatedAt, setPriceUpdatedAt] = useState(null);
  const priceUpdateTimer = useRef(null);
  const suppressPriceWrite = useRef(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [userDoc, setUserDoc] = useState(null);
  const [pendingUsers, setPendingUsers] = useState([]);
  const [presenceDocs, setPresenceDocs] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);

  const feeRate = useMemo(() => {
    const v = toNum(s.feePct, 0) / 100;
    return Math.max(0, Math.min(0.5, v));
  }, [s.feePct]);

  const reset = () => {
    try {
      localStorage.removeItem("miner_eff_v6");
    } catch {
      // ignore
    }
    setS(defaultState);
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
    if (!authUser) {
      setPresenceDocs([]);
      setOnlineUsers([]);
      return undefined;
    }
    const ref = doc(db, "presence", authUser.uid);
    const writePresence = () =>
      setDoc(
        ref,
        {
          uid: authUser.uid,
          displayName: authUser.displayName || "",
          email: authUser.email || "",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    writePresence();
    const timer = setInterval(writePresence, 30000);
    return () => clearInterval(timer);
  }, [authUser]);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "presence"), (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setPresenceDocs(rows);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const update = () => {
      const cutoff = Date.now() - 2 * 60 * 1000;
      const online = presenceDocs.filter((u) => {
        if (!u.updatedAt?.toDate) return false;
        return u.updatedAt.toDate().getTime() >= cutoff;
      });
      setOnlineUsers(online);
    };
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, [presenceDocs]);

  useEffect(() => {
    if (!authUser) {
      setUserDoc(null);
      return undefined;
    }
    const userRef = doc(db, "users", authUser.uid);
    (async () => {
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
    })();

    const unsub = onSnapshot(userRef, (snap) => {
      if (!snap.exists()) {
        setUserDoc({ uid: authUser.uid, status: "pending" });
        return;
      }
      setUserDoc({ id: snap.id, ...snap.data() });
    });
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
    const ref = doc(db, "shared", "prices");
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data();
      const ts = data?.updatedAt?.toDate ? data.updatedAt.toDate() : null;
      setPriceUpdatedAt(ts);
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

  useEffect(() => {
    if (suppressPriceWrite.current) {
      suppressPriceWrite.current = false;
      return;
    }
    if (priceUpdateTimer.current) {
      clearTimeout(priceUpdateTimer.current);
    }
    priceUpdateTimer.current = setTimeout(() => {
      setDoc(
        doc(db, "shared", "prices"),
        {
          ingotGrossPrice: s.ingotGrossPrice,
          gemGrossPrice: s.gemGrossPrice,
          prices: s.prices,
          abilityGrossSell: s.abilityGrossSell,
          lifeGrossSell: s.lifeGrossSell,
          potionPrices: s.potionPrices,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }, 800);
    return () => {
      if (priceUpdateTimer.current) clearTimeout(priceUpdateTimer.current);
    };
  }, [s.ingotGrossPrice, s.gemGrossPrice, s.prices, s.abilityGrossSell, s.lifeGrossSell, s.potionPrices]);

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

  // IngotPage?먯꽌 ?먮ℓ媛 ?낅젰??留됯퀬(placeholder), ?ㅼ젣 ?낅젰? profile?먯꽌留??섎젮怨?
  // ?? 湲곗〈 援ъ“瑜??ш쾶 諛붽씀吏 ?딄린 ?꾪빐 ?쒖엯???꾩튂 ?대룞?앸쭔 ?섍퀬, 媛믪? 洹몃?濡??ъ슜?⑸땲??
  const setActive = (key) => setS((p) => ({ ...p, activeMenu: key }));
  const canUseApp = !!authUser && userDoc?.status === "approved";
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
          <Sidebar active={s.activeMenu} onSelect={setActive} onlineUsers={onlineUsers} />
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
                    {fmt(toNum(s.feePct))}
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
              <ProfilePage s={s} setS={setS} feeRate={feeRate} priceUpdatedAt={priceUpdatedAt} />
            ) : null}
            {s.activeMenu === "potion" ? (
              <PotionPage s={s} setS={setS} feeRate={feeRate} priceUpdatedAt={priceUpdatedAt} />
            ) : null}
            {s.activeMenu === "ingot" ? (
              <IngotPage s={s} setS={setS} feeRate={feeRate} priceUpdatedAt={priceUpdatedAt} />
            ) : null}
            {s.activeMenu === "feedback" ? <FeedbackPage s={s} setS={setS} /> : null}
            {s.activeMenu === "village" ? (
              <VillageSuggestionPage s={s} />
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

