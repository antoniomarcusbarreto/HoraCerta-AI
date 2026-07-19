import React, { useState, useRef, useEffect } from "react";
import { Medicado, Medicamento, DoseLog } from "../types";
import { getDoseTimesForMedOnDate, isMedActiveOnDay, isDoseTaken } from "../utils/doseSchedule";
import { processImageFile, IMAGE_MAX_DIMENSION } from "../imageUtils";
import ConfirmDialog from "./ConfirmDialog";
import {
  Plus, 
  Users, 
  Heart, 
  Clock, 
  FileText, 
  ChevronRight, 
  Check, 
  Trash2, 
  Edit2, 
  AlertCircle,
  Camera,
  Upload,
  Image as ImageIcon,
  X,
  RefreshCw 
} from "lucide-react";

interface DashboardProps {
  medicados: Medicado[];
  medicamentos: Medicamento[];
  doseLogs: DoseLog[];
  onAddPatient: (patient: Omit<Medicado, "medicadoId" | "createdAt" | "userId">) => void;
  onUpdatePatient: (patient: Medicado) => void;
  onDeletePatient: (patientId: string) => void;
  onToggleDose: (medId: string, plannedTime: string) => void;
  onViewSchedule: (date: Date, patientId?: string) => void;
  onNotify: (message: string) => void;
}

export default function Dashboard({
  medicados,
  medicamentos,
  doseLogs,
  onAddPatient,
  onUpdatePatient,
  onDeletePatient,
  onNotify,
  onToggleDose,
  onViewSchedule,
}: DashboardProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState<Medicado | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  // Form states for Medicados
  const [patientName, setPatientName] = useState("");
  const [relationship, setRelationship] = useState("Filho(a)");
  const [birthDate, setBirthDate] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");

  // Camera & File upload states
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Clean up camera stream on unmount
  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraStream]);

  const startCamera = async () => {
    try {
      setCameraActive(true);
      // Câmera traseira por padrão: esta foto é do paciente (que pode não ser
      // quem está segurando o celular), não uma selfie de quem está cadastrando.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: "environment" } }
        });
      } catch {
        // Dispositivo sem câmera traseira (ex.: notebook/desktop) — usa a que houver.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" }
        });
      }
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      console.error("Erro ao acessar a câmera:", err);
      onNotify("Não foi possível acessar a câmera. Por favor, certifique-se de que deu permissões de câmera.");
      setCameraActive(false);
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setCameraActive(false);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      // Cap the captured square at IMAGE_MAX_DIMENSION so the stored base64 stays
      // small (patient photos live inside the Firestore doc / localStorage).
      const srcSize = Math.min(videoRef.current.videoWidth, videoRef.current.videoHeight) || 300;
      const outSize = Math.min(srcSize, IMAGE_MAX_DIMENSION);
      const canvas = document.createElement("canvas");
      canvas.width = outSize;
      canvas.height = outSize;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const sx = (videoRef.current.videoWidth - srcSize) / 2;
        const sy = (videoRef.current.videoHeight - srcSize) / 2;
        ctx.drawImage(videoRef.current, sx, sy, srcSize, srcSize, 0, 0, outSize, outSize);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        setPhotoUrl(dataUrl);
      }
      stopCamera();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    // Validate type/size and downscale before storing (patient photos are
    // persisted as base64 in the Firestore doc + localStorage).
    const result = await processImageFile(file);
    if (!result.ok || !result.dataUrl) {
      onNotify(result.error || "Não foi possível processar a imagem.");
      return;
    }
    setPhotoUrl(result.dataUrl);
  };

  const triggerFileSelect = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Helper to open patient add/edit modal
  const handleOpenAdd = () => {
    setPatientName("");
    setRelationship("Filho(a)");
    setBirthDate("");
    setPhotoUrl("");
    setEditingPatient(null);
    setCameraActive(false);
    setCameraStream(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (p: Medicado, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingPatient(p);
    setPatientName(p.name);
    setRelationship(p.relationship);
    setBirthDate(p.birthDate || "");
    setPhotoUrl(p.photoUrl || "");
    setCameraActive(false);
    setCameraStream(null);
    setShowAddModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientName.trim()) return;

    if (editingPatient) {
      onUpdatePatient({
        ...editingPatient,
        name: patientName,
        relationship,
        birthDate: birthDate || undefined,
        photoUrl: photoUrl || undefined,
      });
    } else {
      onAddPatient({
        name: patientName,
        relationship,
        birthDate: birthDate || undefined,
        photoUrl: photoUrl || undefined,
      });
    }
    stopCamera();
    setShowAddModal(false);
  };

  // Helper to calculate times based on medication intervals
  const getTimesForInterval = (interval: number) => {
    if (interval === 8) return "08:00 • 16:00 • 00:00";
    if (interval === 12) return "09:00 • 21:00";
    if (interval === 6) return "06:00 • 12:00 • 18:00 • 00:00";
    if (interval >= 24) return "08:00";
    const times = [];
    let h = 8;
    while (h < 24) {
      times.push(`${String(h).padStart(2, "0")}:00`);
      h += interval;
    }
    return times.join(" • ") || "08:00";
  };

  // Filter active medications
  const activeMedicamentos = medicamentos.filter(m => isMedActiveOnDay(m, new Date()));

  // Dynamically calculate today's planned doses from active medications
  const todayDosePlans = activeMedicamentos.flatMap((med) => {
    const times = getDoseTimesForMedOnDate(med, new Date());
    const patient = medicados.find(p => p.medicadoId === med.medicadoId);
    const patientName = patient ? patient.name : "Paciente";

    return times.map((time, idx) => ({
      id: `${med.medicamentoId}_${idx}`,
      medId: med.medicamentoId,
      name: med.name,
      time,
      patient: patientName,
      photoUrl: patient?.photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop"
    }));
  });

  // Match logs taken today
  const takenDoseCount = todayDosePlans.filter(plan => {
    return doseLogs.some(log => {
      if (log.medicamentoId !== plan.medId) return false;
      if (log.status !== "taken") return false;
      return log.plannedTime.includes(`T${plan.time}:00`);
    });
  }).length;

  const totalDosesCount = todayDosePlans.length;
  const adherencePercent = totalDosesCount > 0 ? Math.round((takenDoseCount / totalDosesCount) * 100) : 100;

  // Get active medicines grouped by patient for today
  const getTodayPatientSchedule = () => {
    const today = new Date();
    const grouped: Array<{
      patient: Medicado;
      meds: Array<{
        med: Medicamento;
        times: string[];
      }>;
    }> = [];

    medicados.forEach((patient) => {
      const patientMeds = activeMedicamentos.filter(
        m => m.medicadoId === patient.medicadoId
      );

      const medsWithTimes = patientMeds.map(med => {
        const times = getDoseTimesForMedOnDate(med, today);
        return { med, times };
      }).filter(item => item.times.length > 0);

      if (medsWithTimes.length > 0) {
        grouped.push({
          patient,
          meds: medsWithTimes
        });
      }
    });

    return grouped;
  };

  const todayPatientSchedules = getTodayPatientSchedule();

  return (
    <div className="pb-32 px-4 max-w-md lg:max-w-none mx-auto lg:mx-0 pt-6 lg:pt-0 lg:px-0 animate-fade-in">
      {/* Top Header Section */}
      <div className="flex items-center justify-between mb-6 bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs">
        <div>
          <span className="text-xs font-mono text-brand-coral font-bold tracking-widest">HoraCerta AI</span>
          <h1 className="text-3xl font-display font-bold text-brand-teal mt-0.5 tracking-tight">
            Olá, <span className="text-brand-coral">Antonio</span>
          </h1>
          <p className="text-xs text-gray-500 font-sans mt-0.5">Sua saúde guiada por inteligência artificial.</p>
        </div>
        <div className="w-10 h-10 rounded-full bg-brand-teal-pale border border-brand-cream-darker flex items-center justify-center">
          <Heart className="w-5 h-5 text-brand-teal" />
        </div>
      </div>

      {/* Progress Card (Matching left screen top card) */}
      <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-md mb-8 relative overflow-hidden">
        {/* Subtle background graphics */}
        <div className="absolute right-0 bottom-0 w-24 h-24 bg-brand-teal-light rounded-full translate-x-8 translate-y-8 opacity-20" />
        <div className="absolute left-1/3 top-2 w-16 h-16 bg-brand-teal-light rounded-full -translate-y-8 opacity-10" />

        <div className="flex items-center justify-between relative z-10">
          <div className="max-w-[60%]">
            <h3 className="font-display font-medium text-lg leading-snug">
              Seu plano de hoje está quase completo!
            </h3>
            <p className="text-xs text-brand-cream/80 mt-1 font-sans">
              {takenDoseCount} de {totalDosesCount} medicamentos tomados corretamente.
            </p>
            <button
              id="btn-view-schedule"
              onClick={() => onViewSchedule(new Date())}
              className="mt-4 bg-brand-coral hover:bg-brand-coral-light active:scale-95 text-brand-cream text-xs font-semibold px-4 py-2 rounded-xl transition-all shadow-sm"
            >
              Ver Agenda
            </button>
          </div>

          {/* Donut progress chart */}
          <div className="relative w-20 h-20 flex items-center justify-center">
            <svg className="w-full h-full -rotate-90">
              <circle
                cx="40"
                cy="40"
                r="32"
                className="stroke-brand-teal-light fill-transparent"
                strokeWidth="6"
              />
              <circle
                cx="40"
                cy="40"
                r="32"
                className="stroke-brand-coral fill-transparent transition-all duration-500"
                strokeWidth="6"
                strokeDasharray={`${2 * Math.PI * 32}`}
                strokeDashoffset={`${2 * Math.PI * 32 * (1 - adherencePercent / 100)}`}
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute text-sm font-bold font-display">{adherencePercent}%</span>
          </div>
        </div>
      </div>

      {/* Início two-column layout: patients (left) / today's schedule (right) */}
      <div className="lg:grid lg:grid-cols-[1.5fr_1fr] lg:gap-5 lg:items-start">
      {/* Dependents Section (CRUD interface) */}
      <div className="mb-8 lg:mb-0 lg:bg-white lg:border lg:border-brand-cream-darker lg:rounded-3xl lg:shadow-xs lg:p-6">
        <div className="flex items-center justify-between mb-4 bg-white/60 border border-brand-cream-darker rounded-2xl px-4 py-3 lg:bg-transparent lg:border-0 lg:px-0 lg:py-0 lg:rounded-none">
          <h2 className="text-lg font-display font-bold text-brand-teal flex items-center gap-2 whitespace-nowrap">
            <Users className="w-5 h-5 text-brand-coral" /> Pacientes Monitorados
          </h2>
          <button
            id="btn-add-patient"
            onClick={handleOpenAdd}
            className="text-xs bg-brand-teal-pale text-brand-teal hover:bg-brand-cream-darker px-3 py-1.5 rounded-xl font-semibold flex items-center gap-1 transition-all"
          >
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        </div>

        {medicados.length === 0 ? (
          <div className="bg-white border border-dashed border-brand-cream-darker rounded-2xl p-6 text-center">
            <Users className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500">Nenhum paciente cadastrado ainda.</p>
            <button
              onClick={handleOpenAdd}
              className="text-xs text-brand-coral font-bold mt-1 inline-block"
            >
              Cadastre o primeiro dependente
            </button>
          </div>
        ) : (
          <div className="flex space-x-3 overflow-x-auto pb-2 scrollbar-none lg:grid lg:grid-cols-[repeat(auto-fill,minmax(150px,190px))] lg:justify-start lg:gap-3.5 lg:overflow-visible lg:space-x-0">
            {medicados.map(p => (
              <div
                key={p.medicadoId}
                id={`patient-card-${p.medicadoId}`}
                className="flex-shrink-0 lg:w-auto bg-white border border-brand-cream-darker rounded-2xl p-3 w-36 relative shadow-xs hover:shadow-md transition-all"
              >
                {/* CRUD Controls overlay */}
                <div className="absolute top-2 right-2 flex space-x-1">
                  <button
                    onClick={(e) => handleOpenEdit(p, e)}
                    className="p-1 rounded bg-white/80 hover:bg-white text-brand-teal hover:text-brand-coral transition-all"
                    title="Editar"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDialog({
                        title: "Excluir paciente",
                        message: `Tem certeza que deseja excluir ${p.name}? Essa ação não pode ser desfeita.`,
                        onConfirm: () => {
                          onDeletePatient(p.medicadoId);
                          setConfirmDialog(null);
                        },
                      });
                    }}
                    className="p-1 rounded bg-white/80 hover:bg-white text-red-500 hover:text-red-700 transition-all"
                    title="Excluir"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                <div className="flex flex-col items-center text-center mt-2">
                  <img
                    src={p.photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop"}
                    alt={p.name}
                    referrerPolicy="no-referrer"
                    className="w-12 h-12 rounded-full border-2 border-brand-teal/20 object-cover mb-2"
                  />
                  <h4 className="text-xs font-semibold text-brand-teal line-clamp-1">{p.name}</h4>
                  <span className="text-[10px] text-gray-500 font-medium px-2 py-0.5 bg-brand-teal-pale rounded-full mt-1">
                    {p.relationship}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Today's Schedule Grid (Grouped by Patient - "Programação do dia") */}
      <div className="mb-8 lg:mb-0 lg:bg-white lg:border lg:border-brand-cream-darker lg:rounded-3xl lg:shadow-xs lg:p-6">
        <h2 className="text-lg font-display font-bold text-brand-teal flex items-center gap-2 mb-4 bg-white/60 border border-brand-cream-darker rounded-2xl px-4 py-3 lg:bg-transparent lg:border-0 lg:px-0 lg:py-0 lg:rounded-none whitespace-nowrap">
          <Clock className="w-5 h-5 text-brand-coral" /> Programação do dia
        </h2>

        <div className="grid grid-cols-1 gap-4 lg:flex lg:flex-col lg:gap-3.5">
          {todayPatientSchedules.length === 0 ? (
            /* Placeholder Card when no medicines are active */
            <div className="bg-brand-peach border border-brand-coral/10 rounded-3xl p-6 flex flex-col justify-center items-center text-center h-44 shadow-sm hover:scale-[1.02] transition-transform w-full">
              <Clock className="w-8 h-8 text-brand-coral mb-2 opacity-80" />
              <h3 className="font-display font-bold text-sm text-brand-teal">Sem Remédios</h3>
              <p className="text-[11px] text-gray-500 mt-1 px-4 text-center">Nenhum paciente possui medicamentos programados para o dia de hoje.</p>
            </div>
          ) : (
            todayPatientSchedules.map(({ patient, meds }, index) => {
              const patientPhoto = patient.photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop";
              
              // Cycle through 3 different premium styling themes to keep the design highly polished and distinct
              let cardBgClass = "bg-brand-peach border border-brand-coral/10 shadow-xs";
              let textTitleClass = "text-brand-teal";
              let textSubClass = "text-gray-500";
              let pillBgClass = "bg-brand-coral/15 text-brand-teal/80";
              let avatarBorderClass = "border-brand-coral/20";
              let badgeBgClass = "bg-brand-coral/10 text-brand-coral";
              let arrowClass = "text-brand-coral/60";

              if (index % 3 === 1) {
                // Light Cream / White Card
                cardBgClass = "bg-white border border-brand-cream-darker shadow-xs";
                textTitleClass = "text-brand-teal";
                textSubClass = "text-gray-500";
                pillBgClass = "bg-brand-teal-pale text-brand-teal";
                avatarBorderClass = "border-brand-teal/10";
                badgeBgClass = "bg-brand-teal/5 text-brand-teal/70";
                arrowClass = "text-brand-teal/50";
              } else if (index % 3 === 2) {
                // Dark Teal Colored Card
                cardBgClass = "bg-brand-teal text-brand-cream shadow-sm";
                textTitleClass = "text-brand-cream";
                textSubClass = "text-brand-cream/70";
                pillBgClass = "bg-brand-teal-light text-brand-coral";
                avatarBorderClass = "border-brand-cream/20";
                badgeBgClass = "bg-brand-cream/10 text-brand-cream/80";
                arrowClass = "text-brand-coral-light";
              }

              return (
                <div
                  key={patient.medicadoId}
                  onClick={() => onViewSchedule(new Date(), patient.medicadoId)}
                  className={`${cardBgClass} rounded-3xl p-5 flex flex-col justify-between hover:scale-[1.01] hover:shadow-md active:scale-95 transition-all duration-200 cursor-pointer`}
                >
                  {/* Card Header: Patient profile & name */}
                  <div className="flex items-center justify-between mb-4 pb-3 border-b border-dashed border-gray-200/10">
                    <div className="flex items-center gap-3">
                      <img
                        src={patientPhoto}
                        alt={patient.name}
                        referrerPolicy="no-referrer"
                        className={`w-9 h-9 rounded-full object-cover border-2 ${avatarBorderClass} shrink-0`}
                      />
                      <div>
                        <h3 className={`font-display font-bold text-sm tracking-tight ${textTitleClass}`}>
                          {patient.name}
                        </h3>
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${badgeBgClass} px-2 py-0.5 rounded-full mt-0.5 inline-block`}>
                          {patient.relationship}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className={`w-5 h-5 shrink-0 ${arrowClass}`} />
                  </div>

                  {/* List of medications for today */}
                  <div className="space-y-3">
                    {meds.map(({ med, times }) => (
                      <div key={med.medicamentoId} className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h4 className={`font-semibold text-xs leading-snug ${textTitleClass} truncate`}>
                            {med.name}
                          </h4>
                          <p className={`text-[11px] font-sans mt-0.5 ${textSubClass} truncate`}>
                            {med.dosage}
                          </p>
                        </div>
                        
                        {/* Times badges */}
                        <div className="flex flex-wrap items-center gap-1 justify-end shrink-0">
                          {times.map((time) => {
                            const now = new Date();
                            const taken = isDoseTaken(doseLogs, med.medicamentoId, now, time);
                            const [doseHour, doseMinute] = time.split(":").map(Number);
                            const doseDateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), doseHour, doseMinute);
                            const isOverdue = !taken && doseDateTime <= now;
                            return (
                              <span
                                key={time}
                                className={`flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded-lg shrink-0 ${
                                  taken
                                    ? "bg-emerald-500 text-white"
                                    : isOverdue
                                    ? "bg-red-500 text-white ring-2 ring-red-300 animate-pulse"
                                    : pillBgClass
                                }`}
                              >
                                {taken ? <Check className="w-3 h-3 shrink-0 stroke-[3]" /> : isOverdue ? <AlertCircle className="w-3 h-3 shrink-0" /> : <Clock className="w-3 h-3 shrink-0" />}
                                {time}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      </div>

      {/* Add / Edit Patient Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm lg:max-w-md w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <h3 className="text-lg font-display font-bold text-brand-teal mb-4">
              {editingPatient ? "Editar Paciente" : "Novo Paciente Monitorado"}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Nome Completo
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Lívia Barreto"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Parentesco
                  </label>
                  <select
                    value={relationship}
                    onChange={(e) => setRelationship(e.target.value)}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  >
                    <option value="Filho(a)">Filho(a)</option>
                    <option value="Pai">Pai</option>
                    <option value="Mãe">Mãe</option>
                    <option value="Cônjuge">Cônjuge</option>
                    <option value="Avô/Avó">Avô/Avó</option>
                    <option value="Outro">Outro</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Nascimento
                  </label>
                  <input
                    type="date"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  />
                </div>
              </div>

              {/* Foto do Paciente */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-brand-teal uppercase tracking-wider">
                  Foto do Paciente
                </label>
                
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*"
                  className="hidden"
                />

                {cameraActive ? (
                  <div className="relative bg-black rounded-2xl overflow-hidden aspect-square w-full flex items-center justify-center border-2 border-brand-coral">
                    <video
                      ref={videoRef}
                      className="w-full h-full object-cover"
                      playsInline
                      muted
                    />
                    <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-2 px-2">
                      <button
                        type="button"
                        onClick={capturePhoto}
                        className="bg-brand-coral hover:bg-brand-coral-light active:scale-95 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 shadow-md"
                      >
                        <Camera className="w-3.5 h-3.5" /> Capturar
                      </button>
                      <button
                        type="button"
                        onClick={stopCamera}
                        className="bg-gray-800 hover:bg-gray-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 shadow-md"
                      >
                        <X className="w-3.5 h-3.5" /> Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 bg-white/60 p-3 rounded-2xl border border-brand-cream-darker">
                    {/* Preview circle */}
                    <div className="relative shrink-0">
                      <img
                        src={photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop"}
                        alt="Preview"
                        referrerPolicy="no-referrer"
                        className="w-16 h-16 rounded-full border-2 border-brand-teal/20 object-cover"
                      />
                      {photoUrl && (
                        <button
                          type="button"
                          onClick={() => setPhotoUrl("")}
                          className="absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white p-1 rounded-full shadow-sm transition-all"
                          title="Remover foto"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5 flex-1">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={triggerFileSelect}
                          className="flex-1 bg-brand-teal-pale text-brand-teal hover:bg-brand-cream-darker px-2 py-1.5 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 transition-all border border-brand-cream-darker"
                        >
                          <Upload className="w-3 h-3" /> Carregar
                        </button>
                        <button
                          type="button"
                          onClick={startCamera}
                          className="flex-1 bg-brand-teal text-brand-cream hover:bg-brand-teal-light px-2 py-1.5 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 transition-all shadow-sm"
                        >
                          <Camera className="w-3 h-3" /> Tirar Foto
                        </button>
                      </div>
                      <p className="text-[9px] text-gray-500 font-sans leading-tight">
                        PNG, JPG ou foto de câmera
                      </p>
                    </div>
                  </div>
                )}


              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    stopCamera();
                    setShowAddModal(false);
                  }}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2 text-sm font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-brand-teal text-brand-cream rounded-xl py-2 text-sm font-semibold hover:bg-brand-teal-light transition-all shadow-sm"
                >
                  Salvar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title || ""}
        message={confirmDialog?.message || ""}
        danger
        confirmLabel="Excluir"
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
