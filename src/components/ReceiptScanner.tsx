import React, { useState, useRef } from "react";
import { auth } from "../firebase";
import { CupomFiscal } from "../types";
import { TRIAL_SCAN_LIMIT } from "../subscription";
import { Upload, Camera, FileText, Sparkles, Check, ArrowRight, Loader2, Calendar, ShoppingBag, Plus, Trash2, AlertCircle } from "lucide-react";

interface ReceiptScannerProps {
  onScanComplete: (
    establishment: string,
    date: string,
    items: { name: string; price: number }[],
    totalPrice: number
  ) => void;
  onCancel: () => void;
}

// Preset receipt mock to allow immediate testing without uploading
const MOCK_EXTRACTED_RECEIPT = {
  establishment: "Drogaria São Paulo S/A",
  date: "10/07/2026",
  items: [
    { name: "Paracetamol 750mg C/20 Comprimidos", price: 14.90 },
    { name: "Dipirona Monoidratada Gotas 20ml", price: 9.80 },
    { name: "Protetor Solar Neutrogena FPS 60 120ml", price: 54.90 },
  ],
  totalPrice: 79.60,
};

export default function ReceiptScanner({
  onScanComplete,
  onCancel,
}: ReceiptScannerProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStep, setScanStep] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  // Extracted data state
  const [extractedData, setExtractedData] = useState<{
    establishment: string;
    date: string;
    items: { name: string; price: number }[];
    totalPrice: number;
  } | null>(null);

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
    "Carregando foto do cupom fiscal...",
    "Conectando aos servidores do HoraCerta AI...",
    "Extraindo estabelecimento e data da compra...",
    "Lendo lista de itens, quantidades e valores individuais...",
    "Calculando integridade dos preços e totalização..."
  ];

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

  // Convert File to Base64
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

  // Trigger Gemini Scanner
  const handleStartScan = async () => {
    if (!file) return;
    setIsScanning(true);
    setScanStep(0);
    setScanError(null);

    // Simulate progress visual timer
    const timer = setInterval(() => {
      setScanStep((prev) => {
        if (prev < scanStepsText.length - 1) {
          return prev + 1;
        }
        return prev;
      });
    }, 1200);

    try {
      const base64Data = await convertToBase64(file);
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        throw new Error("Sessão expirada. Faça login novamente.");
      }
      const response = await fetch("/api/gemini/extract-receipt", {
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
        establishment: parsedData.establishment || "Farmácia Não Identificada",
        date: parsedData.date || new Date().toLocaleDateString("pt-BR"),
        items: parsedData.items || [],
        totalPrice: parsedData.totalPrice || 0,
      });
    } catch (err: any) {
      clearInterval(timer);
      console.warn("Falha na leitura da nota fiscal:", err);
      // Only simulate in true demo mode (server has NO Gemini key). A real
      // failure — expired session (401), subscription required (403) or a
      // server error — must surface honestly and never fabricate a receipt.
      if (hasApiKey === false) {
        setScanStep(scanStepsText.length - 1);
        setExtractedData(MOCK_EXTRACTED_RECEIPT);
        setScanError("Modo demonstração: sem chave de IA ativa, exibimos uma nota de exemplo. Nada foi lido da sua imagem — revise antes de salvar.");
      } else {
        const code = err?.code;
        if (code === "TRIAL_SCAN_LIMIT_REACHED") {
          setScanError(`Você já utilizou seus ${TRIAL_SCAN_LIMIT} scans gratuitos de nota fiscal do período de testes. Assine um plano para continuar usando o leitor de notas.`);
        } else if (code === "SUBSCRIPTION_REQUIRED") {
          setScanError("É necessária uma assinatura ativa para usar o leitor de notas. Ative um plano e tente novamente.");
        } else {
          setScanError("Não foi possível ler a nota fiscal. Verifique sua conexão e envie uma foto nítida, ou tente novamente em instantes.");
        }
      }
    } finally {
      setIsScanning(false);
    }
  };

  const handleTestMock = () => {
    setIsScanning(true);
    setScanStep(0);
    setScanError(null);

    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep += 1;
      setScanStep(currentStep);
      if (currentStep >= scanStepsText.length) {
        clearInterval(interval);
        setExtractedData(MOCK_EXTRACTED_RECEIPT);
        setIsScanning(false);
      }
    }, 600);
  };

  // Editable fields handler
  const handleItemFieldChange = (index: number, key: string, val: any) => {
    if (!extractedData) return;
    const updatedItems = [...extractedData.items];
    updatedItems[index] = { ...updatedItems[index], [key]: val };
    
    // Recalculate total price if prices changed
    const newTotal = updatedItems.reduce((acc, curr) => acc + (Number(curr.price) || 0), 0);
    
    setExtractedData({ 
      ...extractedData, 
      items: updatedItems,
      totalPrice: Number(newTotal.toFixed(2))
    });
  };

  const handleAddItem = () => {
    if (!extractedData) return;
    const newItem = { name: "Novo Item", price: 0 };
    setExtractedData({
      ...extractedData,
      items: [...extractedData.items, newItem]
    });
  };

  const handleRemoveItem = (index: number) => {
    if (!extractedData) return;
    const updated = extractedData.items.filter((_, idx) => idx !== index);
    const newTotal = updated.reduce((acc, curr) => acc + (Number(curr.price) || 0), 0);
    setExtractedData({
      ...extractedData,
      items: updated,
      totalPrice: Number(newTotal.toFixed(2))
    });
  };

  const handleSaveReceipt = () => {
    if (!extractedData) return;
    onScanComplete(
      extractedData.establishment,
      extractedData.date,
      extractedData.items,
      extractedData.totalPrice
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
            <h2 className="text-xl font-display font-bold text-brand-teal">Leitor de Nota Fiscal com IA</h2>
            <p className="text-xs text-gray-500 mt-1 max-w-[85%] mx-auto font-sans">
              Envie uma foto da nota ou cupom fiscal de compra da farmácia. HoraCerta AI lerá o local, os itens comprados, os preços e a data para seu controle de gastos.
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
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  HoraCerta AI Ativo e Pronto
                </div>
              ) : (
                <div className="bg-amber-50 text-amber-900 border border-amber-200/60 rounded-2xl p-4 text-xs text-left">
                  <div className="flex gap-2.5 items-start">
                    <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold text-amber-950 font-display">Modo Demonstração Ativo</p>
                      <p className="text-[11px] text-amber-800 leading-relaxed font-sans">
                        Sem a chave <code className="font-mono bg-amber-100 px-1 rounded text-red-600">GEMINI_API_KEY</code>, usaremos um comprovante farmacêutico simulado super realista para você testar a funcionalidade agora mesmo.
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
            className="border-2 border-dashed border-brand-cream-darker hover:border-brand-coral rounded-2xl p-8 text-center cursor-pointer transition-all bg-brand-cream-dark/20 hover:bg-brand-peach/20 mb-4"
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
                  alt="Receipt Preview"
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
                  <p className="text-xs font-bold text-brand-teal">Selecione ou Arraste a Nota Fiscal</p>
                  <p className="text-[10px] text-gray-400 font-sans mt-0.5">Suporta JPG, PNG ou PDF</p>
                </div>
              </div>
            )}
          </div>



          {/* Action buttons */}
          <div className="space-y-2">
            <button
              disabled={!file}
              onClick={handleStartScan}
              className={`w-full py-3.5 rounded-2xl font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 ${
                file
                  ? "bg-brand-teal hover:bg-brand-teal-light text-brand-cream active:scale-95"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
              }`}
            >
              <Sparkles className="w-4 h-4 fill-brand-cream/10" />
              Escanear Nota Fiscal com IA
            </button>

            <button
              onClick={onCancel}
              className="w-full border border-brand-cream-darker text-gray-500 font-semibold py-3 rounded-2xl text-xs transition-colors"
            >
              Voltar
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

          <h3 className="text-lg font-display font-bold text-brand-teal">Leitura Fiscal Inteligente</h3>
          <p className="text-xs text-brand-coral font-medium mt-1 uppercase tracking-widest font-mono">
            Análise Passo {scanStep + 1} de {scanStepsText.length}
          </p>

          <div className="mt-8 space-y-3 max-w-[95%] mx-auto">
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

      {/* 3. REVIEW EXTRACTED FISCAL SLIP */}
      {extractedData && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs animate-scale-up">
          <div className="flex items-center justify-between border-b border-brand-cream-darker pb-4 mb-4">
            <div>
              <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 fill-brand-coral/10" /> Leitura Concluída
              </span>
              <h2 className="text-lg font-display font-bold text-brand-teal mt-0.5">Revisar Nota Fiscal</h2>
            </div>
            <button
              onClick={() => {
                setExtractedData(null);
                setFile(null);
                setPreviewUrl(null);
              }}
              className="text-xs text-gray-400 hover:text-brand-teal font-semibold"
            >
              Novo Comprovante
            </button>
          </div>

          {/* Fallback Simulation Notice */}
          {scanError && (
            <div className="bg-brand-peach text-brand-teal text-[11px] p-3 rounded-2xl border border-brand-coral/20 flex items-start gap-2 mb-4 leading-normal">
              <AlertCircle className="w-4 h-4 text-brand-coral shrink-0 mt-0.5" />
              <span>{scanError}</span>
            </div>
          )}

          {/* Form setup for establishment / metadata */}
          <div className="space-y-3 mb-5 bg-brand-cream-dark p-4 rounded-2xl border border-brand-cream-darker">
            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1">
                Estabelecimento / Farmácia
              </label>
              <input
                type="text"
                value={extractedData.establishment}
                onChange={(e) => setExtractedData({ ...extractedData, establishment: e.target.value })}
                className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-xs text-brand-teal font-semibold focus:outline-hidden focus:border-brand-coral"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Data da Compra
              </label>
              <input
                type="text"
                value={extractedData.date}
                onChange={(e) => setExtractedData({ ...extractedData, date: e.target.value })}
                className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-xs text-brand-teal focus:outline-hidden"
              />
            </div>
          </div>

          {/* Items Checklist */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
              Itens Comprados ({extractedData.items.length})
            </h3>
            <button
              onClick={handleAddItem}
              className="text-[10px] font-bold text-brand-teal hover:text-brand-coral transition-colors flex items-center gap-0.5 bg-brand-cream px-2 py-1 rounded-lg border border-brand-cream-darker"
            >
              <Plus className="w-3 h-3" /> Add Item
            </button>
          </div>

          <div className="space-y-3 mb-5 max-h-64 overflow-y-auto pr-1">
            {extractedData.items.map((item, index) => (
              <div
                key={index}
                className="border border-brand-cream-darker rounded-xl p-3 bg-white hover:shadow-xs transition-all relative flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1">
                    <label className="text-[8px] font-bold text-gray-400 uppercase block">Nome do Produto</label>
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) => handleItemFieldChange(index, "name", e.target.value)}
                      className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 text-brand-teal font-medium focus:outline-hidden"
                    />
                  </div>

                  <div className="w-24 shrink-0">
                    <label className="text-[8px] font-bold text-gray-400 uppercase block">Preço (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={item.price}
                      onChange={(e) => handleItemFieldChange(index, "price", parseFloat(e.target.value) || 0)}
                      className="w-full border-b border-brand-cream-darker focus:border-brand-coral text-xs py-1 font-semibold text-brand-coral focus:outline-hidden"
                    />
                  </div>

                  <button
                    onClick={() => handleRemoveItem(index)}
                    className="p-1 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors self-end"
                    title="Remover Item"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}

            {extractedData.items.length === 0 && (
              <div className="text-center p-4 border border-dashed border-brand-cream-darker rounded-xl text-xs text-gray-400 font-sans">
                Nenhum item adicionado à nota fiscal.
              </div>
            )}
          </div>

          {/* Total Price summary banner */}
          <div className="bg-brand-teal text-brand-cream rounded-2xl p-4 mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-brand-coral" />
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-brand-cream/75 leading-none">Total Consolidado</p>
                <p className="text-[11px] font-sans text-brand-cream/90 mt-1">Soma calculada de todos os itens</p>
              </div>
            </div>
            <span className="text-xl font-display font-extrabold text-brand-cream">
              R$ {extractedData.totalPrice.toFixed(2).replace(".", ",")}
            </span>
          </div>

          {/* Trigger Registration */}
          <button
            onClick={handleSaveReceipt}
            className="w-full py-4 bg-brand-coral hover:bg-brand-coral-light text-brand-cream rounded-2xl font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-transform active:scale-95"
          >
            Confirmar e Salvar Nota Fiscal
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
