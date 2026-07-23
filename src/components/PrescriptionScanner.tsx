import React, { useState, useRef } from "react";
import { auth } from "../firebase";
import { Medicado, Medicamento, MedicineCategory } from "../types";
import { Upload, Camera, FileText, Sparkles, Check, ArrowRight, Loader2, Calendar, User, Edit2, AlertCircle, Bell } from "lucide-react";

interface PrescriptionScannerProps {
  medicados: Medicado[];
  onScanComplete: (
    doctorName: string,
    date: string,
    medicines: (Omit<Medicamento, "medicamentoId" | "createdAt" | "userId"> & { createdAt?: string })[],
    medicadoId: string
  ) => void;
  onCancel: () => void;
}

// Preset receipt example to allow immediate testing without uploading
const MOCK_EXTRACTED_PRESCRIPTION = {
  doctorName: "Dr. Marcos Vinícius (Cardiologista)",
  date: "09/07/2026",
  medicines: [
    {
      name: "Losartana Potássica 50mg",
      dosage: "1 comprimido",
      intervalHours: 12,
      durationDays: 30,
      instructions: "Tomar um comprimido em jejum pela manhã e outro à noite.",
      category: "pill" as MedicineCategory,
    },
    {
      name: "Amoxicilina 500mg",
      dosage: "1 cápsula",
      intervalHours: 8,
      durationDays: 10,
      instructions: "Tomar de 8 em 8 horas para controle infeccioso.",
      category: "pill" as MedicineCategory,
    },
    {
      name: "Prednisolona Xarope 3mg/ml",
      dosage: "5 ml",
      intervalHours: 24,
      durationDays: 5,
      instructions: "Tomar uma vez ao dia pela manhã, após o café.",
      category: "syrup" as MedicineCategory,
    },
  ],
};

export default function PrescriptionScanner({
  medicados,
  onScanComplete,
  onCancel,
}: PrescriptionScannerProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStep, setScanStep] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  // Active review states
  const [extractedData, setExtractedData] = useState<{
    doctorName: string;
    date: string;
    medicines: any[];
  } | null>(null);

  const [selectedPatientId, setSelectedPatientId] = useState(medicados[0]?.medicadoId || "");
  const [reminderOffset, setReminderOffset] = useState<number>(10);
  const fileInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    fetch("/api/gemini/status")
      .then((res) => res.json())
      .then((data) => {
        setHasApiKey(data.hasKey);
      })
      .catch((err) => {
        console.error("Erro ao carregar status da chave Gemini:", err);
        setHasApiKey(false);
      });
  }, []);

  const scanStepsText = [
    "Carregando imagem da receita...",
    "Conectando aos servidores do HoraCerta AI...",
    "Analisando caligrafia médica e escaneando termos químicos...",
    "Extraindo dosagens, frequências em horas e categorias...",
    "Formatando lista terapêutica estruturada..."
  ];

  // Pré-preenche data/hora de início de cada medicamento extraído com "agora",
  // editável pelo usuário na tela de revisão.
  const withStartDefaults = (medicines: any[]) => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hr = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    return medicines.map((med) => ({
      ...med,
      startDate: med.startDate || `${yyyy}-${mm}-${dd}`,
      startTime: med.startTime || `${hr}:${min}`,
    }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setPreviewUrl(URL.createObjectURL(selectedFile));
      setScanError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const selectedFile = e.dataTransfer.files[0];
      setFile(selectedFile);
      setPreviewUrl(URL.createObjectURL(selectedFile));
      setScanError(null);
    }
  };

  // Convert File to Base64 String
  const convertToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(",")[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // Trigger real backend API call with Gemini
  const handleStartScan = async () => {
    if (!file) return;
    setIsScanning(true);
    setScanStep(0);
    setScanError(null);

    // Simulate step logging progress visually
    const timer = setInterval(() => {
      setScanStep((prev) => {
        if (prev < scanStepsText.length - 1) {
          return prev + 1;
        }
        return prev;
      });
    }, 1500);

    try {
      const base64Data = await convertToBase64(file);
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        throw new Error("Sessão expirada. Faça login novamente.");
      }
      const response = await fetch("/api/gemini/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          imageBase64: base64Data,
          mimeType: file.type || "image/jpeg",
        }),
      });

      clearInterval(timer);

      if (!response.ok) {
        const errJson = await response.json();
        const scanErr = new Error(errJson.details || errJson.error || "Falha na leitura");
        (scanErr as any).code = errJson.code;
        throw scanErr;
      }

      const parsedData = await response.json();
      setExtractedData({
        doctorName: parsedData.doctorName || "",
        date: parsedData.date || new Date().toLocaleDateString("pt-BR"),
        medicines: withStartDefaults(parsedData.medicines || []),
      });
    } catch (err: any) {
      clearInterval(timer);
      console.warn("Falha na leitura da receita:", err);
      // Only fall back to the sample prescription in true demo mode (server has
      // NO Gemini key). A real failure — expired session (401), subscription
      // required (403) or a server error — must surface honestly and NEVER
      // inject fake medicines into a patient's health record.
      if (hasApiKey === false) {
        setScanStep(scanStepsText.length - 1);
        setExtractedData({
          ...MOCK_EXTRACTED_PRESCRIPTION,
          medicines: withStartDefaults(MOCK_EXTRACTED_PRESCRIPTION.medicines),
        });
        setScanError("Modo demonstração: sem chave de IA ativa, exibimos uma receita de exemplo. Nada foi lido da sua imagem — revise antes de salvar.");
      } else {
        const code = err?.code;
        if (code === "TRIAL_SCAN_LIMIT_REACHED") {
          setScanError("Você já utilizou seu scan gratuito de receita do período de testes. Assine um plano para continuar usando o leitor de receitas.");
        } else if (code === "SUBSCRIPTION_REQUIRED") {
          setScanError("É necessária uma assinatura ativa para usar o leitor de receitas. Ative um plano e tente novamente.");
        } else {
          setScanError("Não foi possível ler a receita. Verifique sua conexão e envie uma foto nítida, ou tente novamente em instantes.");
        }
      }
    } finally {
      setIsScanning(false);
    }
  };

  // Skip upload and test immediately with the Mock prescription
  const handleTestMock = () => {
    setIsScanning(true);
    setScanStep(0);
    setScanError(null);

    // Quick visual progression
    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep += 1;
      setScanStep(currentStep);
      if (currentStep >= scanStepsText.length) {
        clearInterval(interval);
        setExtractedData({
          ...MOCK_EXTRACTED_PRESCRIPTION,
          medicines: withStartDefaults(MOCK_EXTRACTED_PRESCRIPTION.medicines),
        });
        setIsScanning(false);
      }
    }, 600);
  };

  // Handle corrections during user review
  const handleFieldChange = (index: number, key: string, val: any) => {
    if (!extractedData) return;
    const updatedMeds = [...extractedData.medicines];
    updatedMeds[index] = { ...updatedMeds[index], [key]: val };
    setExtractedData({ ...extractedData, medicines: updatedMeds });
  };

  const handleSavePrescription = () => {
    if (!extractedData || !selectedPatientId) return;
    const medicinesWithReminder = extractedData.medicines.map((m) => {
      const { startDate, startTime, ...rest } = m;
      const dateParts = (startDate || "").split("-");
      const timeParts = (startTime || "08:00").split(":");
      const createdAt =
        dateParts.length === 3
          ? new Date(
              Number(dateParts[0]),
              Number(dateParts[1]) - 1,
              Number(dateParts[2]),
              Number(timeParts[0]),
              Number(timeParts[1]),
              0,
              0
            ).toISOString()
          : undefined;
      return { ...rest, reminderOffset, createdAt };
    });
    onScanComplete(
      extractedData.doctorName,
      extractedData.date,
      medicinesWithReminder,
      selectedPatientId
    );
  };

  return (
    <div className="pb-32 px-4 max-w-md lg:max-w-2xl mx-auto pt-6 lg:pt-0 lg:px-0 animate-fade-in">
      {/* 1. INITIAL UPLOAD SCREEN */}
      {!isScanning && !extractedData && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-6 shadow-xs">
          <div className="text-center mb-6">
            <div className="w-12 h-12 bg-brand-peach text-brand-coral rounded-2xl flex items-center justify-center mx-auto mb-3">
              <Sparkles className="w-6 h-6 fill-brand-coral/10" />
            </div>
            <h2 className="text-xl font-display font-bold text-brand-teal">Leitor de Receitas com IA</h2>
            <p className="text-xs text-gray-500 mt-1 max-w-[85%] mx-auto font-sans">
              Envie uma foto legível da sua receita médica. HoraCerta AI irá extrair as dosagens e horários automaticamente.
            </p>
          </div>

          {/* Real failure feedback (expired session, subscription required,
              server error). Must live on THIS screen too: on a real error we
              intentionally do not set extractedData, so the review screen —
              where the other scanError banner lives — never renders. */}
          {scanError && (
            <div className="mb-5 bg-red-50 text-red-800 border border-red-100 rounded-2xl p-3.5 flex items-start gap-2.5 text-xs animate-fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
              <span className="leading-snug font-sans">{scanError}</span>
            </div>
          )}

          {/* AI Key Status Check */}
          {hasApiKey !== null && (
            <div className="mb-5 animate-fade-in">
              {hasApiKey ? (
                <div className="flex items-center justify-center gap-2 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-2xl py-2 px-3 text-xs font-medium">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-duration-1000"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  HoraCerta AI Ativo e Pronto
                </div>
              ) : (
                <div className="bg-amber-50 text-amber-900 border border-amber-200/60 rounded-2xl p-4 text-xs text-left">
                  <div className="flex gap-2.5 items-start">
                    <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold text-amber-950">Chave AI Não Detectada (Modo Demonstração)</p>
                      <p className="text-[11px] text-amber-800 leading-relaxed font-sans">
                        A variável <code className="font-mono bg-amber-100 px-1 rounded text-red-600">GEMINI_API_KEY</code> está ausente no ambiente de execução.
                      </p>
                      <p className="text-[11px] text-amber-800 leading-relaxed font-sans mt-1">
                        Para habilitar a leitura real de suas próprias fotos, clique no ícone de <strong className="font-semibold">Engrenagem (Settings)</strong> no canto superior direito do painel do AI Studio, selecione a aba <strong className="font-semibold">Secrets</strong>, e adicione uma nova chave com o nome <strong className="font-semibold text-amber-950">GEMINI_API_KEY</strong>.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Drag & Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-brand-cream-darker hover:border-brand-coral rounded-2xl p-8 text-center cursor-pointer transition-all bg-brand-cream-dark/20 hover:bg-brand-peach/20"
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="image/*"
              className="hidden"
            />
            
            {previewUrl ? (
              <div className="relative max-h-48 overflow-hidden rounded-xl mx-auto flex items-center justify-center">
                <img
                  src={previewUrl}
                  alt="Prescription Preview"
                  className="max-h-44 object-contain rounded-xl"
                />
                <div className="absolute inset-0 bg-black/35 flex items-center justify-center text-white text-xs font-semibold rounded-xl">
                  Alterar Imagem
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center mx-auto shadow-xs text-gray-400">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs font-bold text-brand-teal">Selecione ou Arraste a Foto</p>
                  <p className="text-[10px] text-gray-400 font-sans mt-0.5">Suporta JPG, PNG ou PDF</p>
                </div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="mt-6 space-y-2">
            <button
              id="btn-trigger-scan"
              disabled={!file}
              onClick={handleStartScan}
              className={`w-full py-3.5 rounded-2xl font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 ${
                file
                  ? "bg-brand-teal hover:bg-brand-teal-light text-brand-cream active:scale-95"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
              }`}
            >
              <Sparkles className="w-4 h-4 fill-brand-cream/10" />
              Iniciar Leitura Inteligente
            </button>

            <button
              onClick={onCancel}
              className="w-full border border-brand-cream-darker text-gray-500 font-semibold py-3.5 rounded-2xl text-xs transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* 2. LOADING AI SCANNING PROGRESS */}
      {isScanning && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 shadow-xs text-center animate-fade-in">
          <div className="relative w-20 h-20 mx-auto mb-6 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full border-4 border-brand-teal-pale border-t-brand-coral animate-spin" />
            <Sparkles className="w-8 h-8 text-brand-coral fill-brand-coral/10 animate-pulse" />
          </div>

          <h3 className="text-lg font-display font-bold text-brand-teal">Processando com Inteligência Artificial</h3>
          <p className="text-xs text-brand-coral font-medium mt-1 uppercase tracking-widest font-mono">
            Passo {scanStep + 1} de {scanStepsText.length}
          </p>

          <div className="mt-8 space-y-3 max-w-[90%] mx-auto">
            {scanStepsText.map((text, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-3 text-left transition-all duration-300 ${
                  idx === scanStep
                    ? "opacity-100 scale-100 text-brand-teal font-medium"
                    : idx < scanStep
                    ? "opacity-60 text-green-600 font-sans"
                    : "opacity-30 text-gray-400 font-sans"
                }`}
              >
                <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
                  idx < scanStep ? "bg-green-100 text-green-600" : "bg-brand-teal-pale text-brand-teal"
                }`}>
                  {idx < scanStep ? <Check className="w-3 h-3 stroke-[3]" /> : idx + 1}
                </div>
                <span className="text-xs leading-tight">{text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. REVIEW EXTRACTED THERAPEUTIC PLAN */}
      {extractedData && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs animate-scale-up">
          <div className="flex items-center justify-between border-b border-brand-cream-darker pb-4 mb-4">
            <div>
              <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 fill-brand-coral/10" /> Extração Concluída
              </span>
              <h2 className="text-lg font-display font-bold text-brand-teal mt-0.5">Revisar Prescrição</h2>
            </div>
            <button
              onClick={() => {
                setExtractedData(null);
                setFile(null);
                setPreviewUrl(null);
              }}
              className="text-xs text-gray-400 hover:text-brand-teal font-semibold"
            >
              Novo Escaneamento
            </button>
          </div>

          {/* Safe Demo Indicator Error */}
          {scanError && (
            <div className="bg-brand-peach text-brand-teal text-[11px] p-3 rounded-2xl border border-brand-coral/20 flex items-start gap-2 mb-4 leading-normal">
              <AlertCircle className="w-4 h-4 text-brand-coral shrink-0 mt-0.5" />
              <span>{scanError}</span>
            </div>
          )}

          {/* Form setup for patient / metadata */}
          <div className="space-y-3 mb-6 bg-brand-cream-dark p-4 rounded-2xl border border-brand-cream-darker">
            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1">
                Para Qual Paciente?
              </label>
              <select
                required
                value={selectedPatientId}
                onChange={(e) => setSelectedPatientId(e.target.value)}
                className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-xs text-brand-teal focus:outline-hidden"
              >
                <option value="">Selecione...</option>
                {medicados.map(p => (
                  <option key={p.medicadoId} value={p.medicadoId}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1 flex items-center gap-1">
                  <User className="w-3 h-3" /> Médico(a)
                </label>
                <input
                  type="text"
                  value={extractedData.doctorName}
                  onChange={(e) => setExtractedData({ ...extractedData, doctorName: e.target.value })}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-1.5 text-xs text-brand-teal focus:outline-hidden"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> Data da Receita
                </label>
                <input
                  type="text"
                  value={extractedData.date}
                  onChange={(e) => setExtractedData({ ...extractedData, date: e.target.value })}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-1.5 text-xs text-brand-teal focus:outline-hidden"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1 flex items-center gap-1">
                <Bell className="w-3 h-3" /> Lembrar antes da dose
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[5, 10].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    onClick={() => setReminderOffset(minutes)}
                    className={`px-3 py-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1 transition-all ${
                      reminderOffset === minutes
                        ? "bg-brand-teal text-brand-cream border-brand-teal shadow-xs"
                        : "bg-white border-brand-cream-darker text-brand-teal hover:bg-brand-peach"
                    }`}
                  >
                    {reminderOffset === minutes && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    {minutes} minutos antes
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Medicines Checklist */}
          <h3 className="text-xs font-bold text-brand-teal mb-3 uppercase tracking-wider">
            Medicamentos Detectados ({extractedData.medicines.length})
          </h3>

          <div className="space-y-4 mb-6">
            {extractedData.medicines.map((med, index) => (
              <div
                key={index}
                className="border border-brand-cream-darker rounded-2xl p-4 bg-white hover:shadow-xs transition-all relative"
              >
                {/* Number index badge */}
                <div className="absolute top-3 right-3 text-[10px] font-bold bg-brand-teal-pale text-brand-teal px-2 py-0.5 rounded-full">
                  Remédio #{index + 1}
                </div>

                {/* Inline Editing elements */}
                <div className="space-y-2 pt-1">
                  <div>
                    <label className="text-[9px] font-bold text-gray-400 uppercase block">Nome do Medicamento</label>
                    <input
                      type="text"
                      value={med.name}
                      onChange={(e) => handleFieldChange(index, "name", e.target.value)}
                      className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 text-brand-teal font-semibold focus:outline-hidden"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] font-bold text-gray-400 uppercase block">Dosagem / Quantidade</label>
                      <input
                        type="text"
                        value={med.dosage}
                        onChange={(e) => handleFieldChange(index, "dosage", e.target.value)}
                        className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-gray-400 uppercase block">Tipo / Categoria</label>
                      <select
                        value={med.category}
                        onChange={(e) => handleFieldChange(index, "category", e.target.value)}
                        className="w-full border-b border-brand-cream-darker text-xs py-1 focus:outline-hidden bg-white text-brand-teal"
                      >
                        <option value="pill">Comprimido</option>
                        <option value="syrup">Xarope</option>
                        <option value="drop">Gotas</option>
                        <option value="cream">Pomada</option>
                        <option value="injection">Injetável</option>
                        <option value="other">Outro</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] font-bold text-gray-400 uppercase block">Intervalo de Horas</label>
                      <input
                        type="number"
                        value={med.intervalHours}
                        onChange={(e) => handleFieldChange(index, "intervalHours", Number(e.target.value))}
                        className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-gray-400 uppercase block">Duração (Dias)</label>
                      <input
                        type="number"
                        value={med.durationDays}
                        onChange={(e) => handleFieldChange(index, "durationDays", Number(e.target.value))}
                        className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 focus:outline-hidden"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[9px] font-bold text-gray-400 uppercase block">Instruções Extras</label>
                    <input
                      type="text"
                      value={med.instructions || ""}
                      onChange={(e) => handleFieldChange(index, "instructions", e.target.value)}
                      placeholder="Ex: Tomar com água abundante"
                      className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 focus:outline-hidden placeholder-gray-300"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] font-bold text-gray-400 uppercase block">Data de Início</label>
                      <input
                        type="date"
                        value={med.startDate || ""}
                        onChange={(e) => handleFieldChange(index, "startDate", e.target.value)}
                        className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 focus:outline-hidden bg-white text-brand-teal"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-gray-400 uppercase block">Horário da 1ª Dose</label>
                      <input
                        type="time"
                        value={med.startTime || ""}
                        onChange={(e) => handleFieldChange(index, "startTime", e.target.value)}
                        className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 focus:outline-hidden bg-white text-brand-teal"
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Trigger Registration */}
          <button
            id="btn-confirm-review"
            onClick={handleSavePrescription}
            disabled={!selectedPatientId}
            className={`w-full py-4 rounded-2xl font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-transform active:scale-95 ${
              selectedPatientId
                ? "bg-brand-coral hover:bg-brand-coral-light text-brand-cream"
                : "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
            }`}
          >
            Confirmar e Agendar Medicamentos
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
