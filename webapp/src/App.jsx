import { useEffect, useMemo, useState } from "react";
import { createLabel, listHistory, requestDownload, uploadOcr } from "./api";
import {
  getIdToken,
  observeAuthState,
  signInWithGoogle,
  signInWithMicrosoft,
  signOutUser,
} from "./auth";

const emptyForm = {
  product_name: "",
  function_claim: "",
  usage_instructions: "",
  warnings_precautions: "",
  inci_ingredients: "",
  distributor: "",
  eu_responsible_person: "",
  country_of_origin: "",
  batch_lot: "",
  expiry_date: "",
  net_content: "",
};

function mapParsedToForm(parsed) {
  return {
    product_name: parsed["Product Name"] || "",
    function_claim: parsed["Function/Claim"] || "",
    usage_instructions: parsed["Usage / Instructions"] || "",
    warnings_precautions: parsed["Warnings / Precautions"] || "",
    inci_ingredients: parsed["INCI / Ingredients"] || "",
    distributor: parsed["Distributor"] || "",
    eu_responsible_person: parsed["EU Responsible Person"] || "",
    country_of_origin: parsed["Country of Origin"] || "",
    batch_lot: parsed["Batch / Lot"] || "",
    expiry_date: parsed["Expiry Date"] || "",
    net_content: parsed["Net Content"] || "",
  };
}

export default function App() {
  const [form, setForm] = useState(emptyForm);
  const [rawText, setRawText] = useState("");
  const [autoWarnings, setAutoWarnings] = useState("");
  const [euText, setEuText] = useState("");
  const [status, setStatus] = useState("Idle");
  const [labelInfo, setLabelInfo] = useState(null);
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyStatus, setHistoryStatus] = useState("Idle");

  useEffect(() => {
    const unsubscribe = observeAuthState(async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        localStorage.removeItem("idToken");
        return;
      }
      const token = await getIdToken();
      if (token) {
        localStorage.setItem("idToken", token);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setHistory([]);
      return;
    }
    const fetchHistory = async () => {
      setHistoryStatus("Loading...");
      try {
        const items = await listHistory();
        setHistory(items);
        setHistoryStatus("Loaded");
      } catch (err) {
        setHistoryStatus("Failed");
      }
    };
    fetchHistory();
  }, [user]);

  const canGenerate = useMemo(() => {
    return Boolean(form.product_name || form.inci_ingredients || form.function_claim);
  }, [form]);

  const canUseApi = Boolean(user);

  const updateField = (name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleOcr = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus("Processing OCR...");
    setLabelInfo(null);

    try {
      const data = await uploadOcr(file);
      setRawText(data.raw_text || "");
      setAutoWarnings(data.auto_warnings || "");
      setEuText(data.eu_label_text || "");
      if (data.parsed) {
        setForm((prev) => ({ ...prev, ...mapParsedToForm(data.parsed) }));
      }
      setStatus("OCR complete");
    } catch (err) {
      setStatus("OCR failed");
      setRawText(String(err));
    }
  };

  const handleGenerate = async () => {
    setStatus("Generating PDF...");
    setLabelInfo(null);

    try {
      const result = await createLabel(form);
      setLabelInfo(result);
      setStatus("PDF ready");
      if (user) {
        const items = await listHistory();
        setHistory(items);
      }
    } catch (err) {
      setStatus("PDF generation failed");
    }
  };

  const handleDownload = async (labelId) => {
    try {
      const result = await requestDownload(labelId);
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setStatus("Download failed");
    }
  };

  return (
    <div className="page">
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="logo">ㅁ</div>
            <div>
              <strong>띵보 COA</strong>
              <p>Label Studio</p>
            </div>
          </div>
          <nav>
            {["메인", "강화계산기", "요리", "채광계산기", "지도", "내정보"].map((item) => (
              <button key={item} className="nav-item">
                <span>■</span>
                <span>{item}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-note">
            <p>탐색을 돕는 사이드바</p>
            <small>더 많은 콘텐츠를 추가해보세요.</small>
          </div>
        </aside>

        <main className="main-content">
          <header className="hero">
            <div>
              <p className="eyebrow">채광 계산기</p>
              <h1>재료 가격과 강화 비용을 한눈에</h1>
              <p>
                예시 데이터를 기반으로 재료, 강화, 출고 비용을 직관적으로 확인하고
                PDF로 저장하세요.
              </p>
            </div>
            <div className="hero-actions">
              <span className="status-chip">{status}</span>
              <button className="primary" disabled={!canGenerate || !canUseApi} onClick={handleGenerate}>
                PDF 생성하기
              </button>
            </div>
          </header>

          <div className="alert-panel">
            <strong>사용 시 주의사항</strong>
            <ul>
              <li>계산은 참고용이며 실제 비용과 차이가 있을 수 있습니다.</li>
              <li>경고와 EU 초안은 OCR 결과를 기반으로 자동 생성됩니다.</li>
              <li>PDF를 생성하면 이력에 저장되어 언제든 다운로드 가능합니다.</li>
            </ul>
          </div>

          <section className="stats-grid">
            {[
              { label: "자동 경고", value: autoWarnings || "없음", help: "OCR에서 감지된 우려 문구" },
              { label: "EU 초안", value: euText ? "초안 준비 완료" : "없음", help: "EU 라벨 텍스트" },
              { label: "OCR 텍스트", value: rawText ? `${rawText.length}글자` : "없음", help: "추출된 전체 텍스트" },
              { label: "이력", value: history.length ? `${history.length}건` : "0건", help: "PDF 다운로드 이력" },
            ].map((stat) => (
              <div className="stat-card" key={stat.label}>
                <h3>{stat.label}</h3>
                <p className="value">{stat.value}</p>
                <small>{stat.help}</small>
              </div>
            ))}
          </section>

          <section className="field-grid">
            {[
              {
                title: "제품 기본",
                description: "제품명과 기능 정보를 빠르게 입력합니다.",
                fields: [
                  { name: "product_name", label: "제품명", type: "text", placeholder: "예: 블레이징 포션" },
                  { name: "function_claim", label: "기능/클레임", type: "text", placeholder: "예: 화상 회복" },
                ],
              },
              {
                title: "안내 문구",
                description: "사용법과 주의 사항을 간략히 정리하세요.",
                fields: [
                  { name: "usage_instructions", label: "사용 설명", type: "textarea", rows: 3 },
                  { name: "warnings_precautions", label: "주의/경고", type: "textarea", rows: 3 },
                ],
              },
              {
                title: "인증 정보",
                description: "공급자 및 원산지 정보를 담습니다.",
                fields: [
                  { name: "distributor", label: "판매자", type: "text", placeholder: "예: 큐이앤에프" },
                  { name: "eu_responsible_person", label: "EU 담당자", type: "textarea", rows: 2 },
                ],
              },
              {
                title: "추가 메타",
                description: "배치번호, 유통기한, 중량 등.",
                fields: [
                  { name: "country_of_origin", label: "원산지", type: "text" },
                  { name: "batch_lot", label: "배치/로트", type: "text" },
                  { name: "expiry_date", label: "유통기한", type: "text" },
                  { name: "net_content", label: "총 중량", type: "text" },
                ],
              },
            ].map((group) => (
              <div className="field-card" key={group.title}>
                <header>
                  <div>
                    <h3>{group.title}</h3>
                    <p>{group.description}</p>
                  </div>
                  <button className="ghost small">OCR 적용</button>
                </header>
                <div className="field-list">
                  {group.fields.map((field) => (
                    <label key={field.name}>
                      <span>{field.label}</span>
                      {field.type === "textarea" ? (
                        <textarea
                          rows={field.rows}
                          value={form[field.name]}
                          onChange={(e) => updateField(field.name, e.target.value)}
                        />
                      ) : (
                        <input
                          placeholder={field.placeholder || ""}
                          value={form[field.name]}
                          onChange={(e) => updateField(field.name, e.target.value)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="output-grid">
            {[{ title: "Auto Warnings", data: autoWarnings }, { title: "EU 라벨 초안", data: euText }, { title: "Raw OCR", data: rawText }].map((item) => (
              <article className="output-card" key={item.title}>
                <div className="output-header">
                  <h3>{item.title}</h3>
                  <span>{item.data ? "적용됨" : "없음"}</span>
                </div>
                <pre>{item.data || "내용을 업로드하거나 OCR을 실행하면 이곳에 노출됩니다."}</pre>
              </article>
            ))}
          </section>

          <section className="history-panel">
            <div className="history-header">
              <h3>이력</h3>
              <p>{historyStatus === "Loading..." ? "불러오는 중..." : "최근 생성된 PDF"}</p>
            </div>
            <div className="history-list">
              {history.length === 0 && historyStatus === "Loaded" ? (
                <p className="muted">생성된 라벨 기록이 없습니다.</p>
              ) : (
                history.map((item) => (
                  <div className="history-card" key={item.label_id}>
                    <div>
                      <strong>{item.product_name || "무제"}</strong>
                      <p>{item.pdf_file_name || "label.pdf"}</p>
                    </div>
                    <button className="ghost" onClick={() => handleDownload(item.label_id)}>
                      다운로드
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
