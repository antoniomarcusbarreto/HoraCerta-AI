import React, { useState } from "react";
import { Medicado, Medicamento, DoseLog, MedicineCategory } from "../types";
import { getDoseTimesForMedOnDate, isMedActiveOnDay, isDoseTaken } from "../utils/doseSchedule";
import ConfirmDialog from "./ConfirmDialog";
import { ChevronLeft, ChevronRight, Bell, Check, Clock, Plus, Trash2, Edit2, ShieldAlert } from "lucide-react";

interface ScheduleProps {
  medicados: Medicado[];
  medicamentos: Medicamento[];
  doseLogs: DoseLog[];
  onAddMedicine: (med: Omit<Medicamento, "medicamentoId" | "createdAt" | "userId"> & { createdAt?: string }) => void;
  onUpdateMedicine: (med: Medicamento) => void;
  onDeleteMedicine: (medId: string) => void;
  onAddDoseLog: (log: Omit<DoseLog, "userId">) => void;
  selectedDate?: Date;
  setSelectedDate?: (date: Date) => void;
  selectedPatientFilterId?: string;
  setSelectedPatientFilterId?: (id: string) => void;
  onNotify: (message: string) => void;
}

export default function Schedule({
  medicados,
  medicamentos,
  doseLogs,
  onAddMedicine,
  onUpdateMedicine,
  onDeleteMedicine,
  onAddDoseLog,
  selectedDate: propSelectedDate,
  setSelectedDate: propSetSelectedDate,
  selectedPatientFilterId: propSelectedPatientFilterId,
  setSelectedPatientFilterId: propSetSelectedPatientFilterId,
  onNotify,
}: ScheduleProps) {
  // Calendar States (Defaults to today)
  const [localSelectedDate, setLocalSelectedDate] = useState<Date>(() => new Date());
  const selectedDate = propSelectedDate || localSelectedDate;
  const setSelectedDate = propSetSelectedDate || setLocalSelectedDate;

  // Patient filter states
  const [localPatientFilterId, setLocalPatientFilterId] = useState<string>("");
  const selectedPatientFilterId = propSelectedPatientFilterId !== undefined ? propSelectedPatientFilterId : localPatientFilterId;
  const setSelectedPatientFilterId = propSetSelectedPatientFilterId || setLocalPatientFilterId;
  
  // Modal states
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [reminderConfigured, setReminderConfigured] = useState<number | null>(10); // Default 10 min
  const [showAddMedModal, setShowAddMedModal] = useState(false);
  const [confirmDeleteMed, setConfirmDeleteMed] = useState<{ medId: string; medName: string; slotTime: string } | null>(null);

  // Form states for Medicine CRUD
  const [medName, setMedName] = useState("");
  const [dosage, setDosage] = useState("");
  const [intervalHours, setIntervalHours] = useState(8);
  const [durationDays, setDurationDays] = useState(7);
  const [category, setCategory] = useState<MedicineCategory>("pill");
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [startDate, setStartDate] = useState(() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  // Confirmation state for administering medicine
  const [doseToConfirm, setDoseToConfirm] = useState<{
    medId: string;
    slotTime: string;
    medName: string;
    patientName: string;
    dosage: string;
    avatar: string;
    plannedISO: string;
  } | null>(null);
  const [confirmTime, setConfirmTime] = useState("");

  // Helper to get Portuguese month and year string (e.g. "Julho, 2026")
  const getMonthYearString = (date: Date) => {
    const months = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
    ];
    return `${months[date.getMonth()]}, ${date.getFullYear()}`;
  };

  // Helper to get short week day name
  const getDayName = (date: Date) => {
    const names = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    return names[date.getDay()];
  };

  // Helper to get full week day name
  const getDayOfWeekLong = (date: Date) => {
    const days = [
      "Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"
    ];
    return days[date.getDay()];
  };

  // Helper to get full month name
  const getMonthLong = (date: Date) => {
    const months = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
    ];
    return months[date.getMonth()];
  };

  // Helper to get week days around a date (7 days of the week starting from Sunday)
  const getWeekDays = (date: Date) => {
    const currentDayOfWeek = date.getDay();
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - currentDayOfWeek);
    
    const days = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(startOfWeek);
      day.setDate(startOfWeek.getDate() + i);
      days.push(day);
    }
    return days;
  };

  // Weekly navigation
  const handlePrevWeek = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() - 7);
    setSelectedDate(d);
  };

  const handleNextWeek = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + 7);
    setSelectedDate(d);
  };

  // Generate dynamic timeline slots for selectedDate
  const activeMedsOnDay = medicamentos.filter((med) => {
    const isActive = isMedActiveOnDay(med, selectedDate);
    if (!isActive) return false;
    if (selectedPatientFilterId) {
      return med.medicadoId === selectedPatientFilterId;
    }
    return true;
  });

  interface DynamicSlot {
    time: string;
    medId: string;
    patientName: string;
    avatar: string;
  }

  const dynamicSlots: DynamicSlot[] = [];

  activeMedsOnDay.forEach((med) => {
    const patient = medicados.find(p => p.medicadoId === med.medicadoId);
    const patientName = patient ? patient.name : "Paciente";
    const avatar = patient?.photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop";
    
    const times = getDoseTimesForMedOnDate(med, selectedDate);

    times.forEach((time) => {
      dynamicSlots.push({
        time,
        medId: med.medicamentoId,
        patientName,
        avatar,
      });
    });
  });

  // Sort slots by time
  dynamicSlots.sort((a, b) => a.time.localeCompare(b.time));

  const calendarDays = getWeekDays(selectedDate);

  const handleOpenAddMed = () => {
    setMedName("");
    setDosage("");
    setIntervalHours(8);
    setDurationDays(7);
    setCategory("pill");
    setSelectedPatientId(medicados[0]?.medicadoId || "");
    setInstructions("");
    setReminderConfigured(10);
    
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    setStartDate(`${yyyy}-${mm}-${dd}`);

    setShowAddMedModal(true);
  };

  const handleCreateMedicine = (e: React.FormEvent) => {
    e.preventDefault();
    if (!medName.trim() || !dosage.trim() || !selectedPatientId) return;

    const parts = startDate.split('-');
    const today = new Date();
    const isToday = today.getFullYear() === Number(parts[0]) &&
                    (today.getMonth() + 1) === Number(parts[1]) &&
                    today.getDate() === Number(parts[2]);

    let localStart;
    if (isToday) {
      localStart = new Date();
    } else {
      localStart = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 8, 0, 0);
    }
    const createdAtISO = localStart.toISOString();

    onAddMedicine({
      name: medName,
      dosage,
      intervalHours: Number(intervalHours),
      durationDays: Number(durationDays),
      category,
      medicadoId: selectedPatientId,
      receitaId: "rec_manual",
      instructions: instructions || undefined,
      status: "active",
      reminderOffset: reminderConfigured || 10,
      createdAt: createdAtISO,
    });

    setShowAddMedModal(false);
  };

  // Open the dose confirmation modal (only reachable for doses not yet taken)
  const toggleDoseTaken = (medId: string, slotTime: string) => {
    const yyyy = selectedDate.getFullYear();
    const mm = String(selectedDate.getMonth() + 1).padStart(2, "0");
    const dd = String(selectedDate.getDate()).padStart(2, "0");
    const datePrefix = `${yyyy}-${mm}-${dd}`;
    const plannedISO = `${datePrefix}T${slotTime}:00.000Z`;

    const med = medicamentos.find(m => m.medicamentoId === medId);
    const patient = medicados.find(p => p.medicadoId === med?.medicadoId);
    const patientName = patient ? patient.name : "Paciente";
    const avatar = patient?.photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop";

    const now = new Date();
    const currentHr = String(now.getHours()).padStart(2, "0");
    const currentMin = String(now.getMinutes()).padStart(2, "0");

    setDoseToConfirm({
      medId,
      slotTime,
      medName: med?.name || "",
      patientName,
      dosage: med?.dosage || "",
      avatar,
      plannedISO,
    });
    setConfirmTime(`${currentHr}:${currentMin}`);
  };

  const handleConfirmDose = (e: React.FormEvent) => {
    e.preventDefault();
    if (!doseToConfirm) return;

    const yyyy = selectedDate.getFullYear();
    const mm = String(selectedDate.getMonth() + 1).padStart(2, "0");
    const dd = String(selectedDate.getDate()).padStart(2, "0");

    // Construct takenTime based on the user's input hour and minute
    const [hr, min] = confirmTime.split(":");
    const takenDate = new Date(selectedDate);
    takenDate.setHours(Number(hr), Number(min), 0, 0);

    onAddDoseLog({
      logId: `log_${Date.now()}`,
      medicamentoId: doseToConfirm.medId,
      medicadoId: medicamentos.find(m => m.medicamentoId === doseToConfirm.medId)?.medicadoId || "unknown",
      plannedTime: doseToConfirm.plannedISO,
      takenTime: takenDate.toISOString(),
      status: "taken",
    });

    setDoseToConfirm(null);
  };

  return (
    <div className="pb-32 px-3 sm:px-4 lg:px-0 max-w-md lg:max-w-none mx-auto lg:mx-0 pt-6 lg:pt-0 animate-fade-in">
      {/* Month Header Grid */}
      <div className="bg-brand-teal text-brand-cream rounded-3xl p-4 sm:p-6 shadow-md mb-6 relative overflow-hidden">
        {/* Header month & arrows */}
        <div className="flex items-center justify-between mb-4">
          <button 
            type="button"
            onClick={handlePrevWeek}
            className="p-1 rounded-full hover:bg-brand-teal-light text-brand-coral transition-colors"
          >
            <ChevronLeft className="w-5 h-5 stroke-[2.5]" />
          </button>
          
          <div className="flex flex-col items-center">
            <span className="font-display font-bold text-base sm:text-lg tracking-tight">
              {getMonthYearString(selectedDate)}
            </span>
            <button
              type="button"
              onClick={() => setSelectedDate(new Date())}
              className="text-[9px] font-bold text-brand-coral bg-brand-peach/20 hover:bg-brand-peach/30 px-2 py-0.5 mt-1 rounded-full border border-brand-coral/25 transition-all active:scale-95"
            >
              Ir para Hoje
            </button>
          </div>

          <button 
            type="button"
            onClick={handleNextWeek}
            className="p-1 rounded-full hover:bg-brand-teal-light text-brand-coral transition-colors"
          >
            <ChevronRight className="w-5 h-5 stroke-[2.5]" />
          </button>
        </div>

        {/* Horizontal Calendar strip */}
        <div className="flex justify-between items-center px-0.5 gap-1">
          {calendarDays.map((day) => {
            const isSelected = selectedDate.getDate() === day.getDate() &&
                               selectedDate.getMonth() === day.getMonth() &&
                               selectedDate.getFullYear() === day.getFullYear();
            const dayName = getDayName(day);
            const dayNum = day.getDate();
            return (
              <button
                key={day.getTime()}
                type="button"
                onClick={() => setSelectedDate(day)}
                className="flex flex-col items-center focus:outline-hidden flex-1 min-w-0"
              >
                <span className="text-[10px] sm:text-xs text-brand-cream/60 font-medium mb-1.5">{dayName}</span>
                <div
                  className={`w-7 h-7 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm transition-all ${
                    isSelected
                      ? "bg-brand-coral text-brand-cream scale-105 sm:scale-110 shadow-sm"
                      : "text-brand-cream hover:bg-brand-teal-light"
                  }`}
                >
                  {dayNum}
                </div>
              </button>
            );
          })}
        </div>

        {/* Big Yellowish CTA: Set Reminder */}
        <button
          id="btn-set-reminder"
          onClick={() => setShowReminderModal(true)}
          className="w-full mt-6 bg-brand-coral hover:bg-brand-coral-light active:scale-95 text-brand-cream font-bold py-3 sm:py-3.5 rounded-2xl transition-all shadow-md flex items-center justify-center gap-2 text-xs sm:text-sm"
        >
          <Bell className="w-4.5 h-4.5 sm:w-5 sm:h-5 fill-brand-cream/10" />
          Configurar Lembrete
        </button>
      </div>

      {/* Patient Filter Chips Row */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2.5 mb-2 scrollbar-none">
        <button
          onClick={() => setSelectedPatientFilterId("")}
          className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all ${
            !selectedPatientFilterId
              ? "bg-brand-coral text-brand-cream shadow-sm"
              : "bg-white text-brand-teal/80 border border-brand-cream-darker hover:bg-brand-peach"
          }`}
        >
          Todos
        </button>
        {medicados.map((patient) => {
          const isSelected = selectedPatientFilterId === patient.medicadoId;
          const patientPhoto = patient.photoUrl || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop";
          return (
            <button
              key={patient.medicadoId}
              onClick={() => setSelectedPatientFilterId(patient.medicadoId)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap flex items-center gap-1.5 transition-all ${
                isSelected
                  ? "bg-brand-coral text-brand-cream shadow-sm"
                  : "bg-white text-brand-teal/80 border border-brand-cream-darker hover:bg-brand-peach"
              }`}
            >
              <img
                src={patientPhoto}
                alt={patient.name}
                referrerPolicy="no-referrer"
                className="w-4 h-4 rounded-full object-cover shrink-0"
              />
              <span>{patient.name.split(" ")[0]}</span>
            </button>
          );
        })}
      </div>

      {/* Title indicating selected day */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <h2 className="text-lg sm:text-xl font-display font-bold text-brand-teal capitalize truncate">
          {getDayOfWeekLong(selectedDate)}, {selectedDate.getDate()} de {getMonthLong(selectedDate)}
        </h2>
        <button
          id="btn-manual-add"
          onClick={handleOpenAddMed}
          className="text-[10px] sm:text-xs font-semibold bg-brand-teal text-brand-cream hover:bg-brand-teal-light px-2 py-1.5 sm:px-3 rounded-xl flex items-center gap-1 transition-all shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Novo
        </button>
      </div>

      {/* Hourly Timeline list */}
      <div className="space-y-6 relative before:absolute before:left-[48px] sm:before:left-[70px] before:top-4 before:bottom-4 before:w-[2px] before:bg-brand-cream-darker">
        {dynamicSlots.length === 0 ? (
          <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center shadow-xs max-w-sm mx-auto relative z-10 animate-fade-in">
            <div className="w-12 h-12 rounded-full bg-brand-peach flex items-center justify-center mx-auto mb-3 text-brand-coral">
              <Clock className="w-6 h-6" />
            </div>
            <h3 className="font-display font-bold text-sm text-brand-teal mb-1">Sem compromissos hoje</h3>
            <p className="text-[11px] text-gray-500 leading-relaxed px-4">
              Nenhum medicamento programado para esta data.
            </p>
          </div>
        ) : (
          dynamicSlots.map((slot, index) => {
            const med = medicamentos.find(m => m.medicamentoId === slot.medId);
            if (!med) return null;
            
            const isTaken = isDoseTaken(doseLogs, slot.medId, selectedDate, slot.time);

            return (
              <div key={index} className="flex items-start gap-2 sm:gap-4 relative z-10 animate-fade-in">
                {/* Hour identifier on the left of timeline line */}
                <div className="w-9 sm:w-12 text-right shrink-0 pt-2 pr-1">
                  <span className="text-[10px] sm:text-xs font-bold font-mono text-brand-teal bg-brand-teal-pale px-1 sm:px-1.5 py-0.5 rounded-lg border border-brand-teal/15 shadow-2xs">
                    {slot.time}
                  </span>
                </div>

                {/* Central point on the timeline line */}
                <div className="pt-3">
                  <div
                    className={`w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full border-2 bg-brand-cream ${
                      isTaken ? "border-brand-coral bg-brand-coral" : "border-brand-teal"
                    }`}
                  />
                </div>

                {/* Medicine Card details on the right */}
                <div className="flex-1 min-w-0">
                  <div
                    id={`med-timeline-${med.medicamentoId}-${index}`}
                    className={`rounded-2xl p-3 sm:p-4 border transition-all flex items-center justify-between gap-2 min-w-0 ${
                      isTaken
                        ? "bg-brand-cream-dark border-brand-cream-darker opacity-75"
                        : "bg-white border-brand-cream-darker shadow-xs"
                    }`}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 overflow-hidden min-w-0 flex-1">
                      {/* Patient Avatar inside schedule slot */}
                      <img
                        src={slot.avatar}
                        alt={slot.patientName}
                        referrerPolicy="no-referrer"
                        className="w-8 h-8 sm:w-10 sm:h-10 rounded-full object-cover border border-brand-teal/10 shrink-0"
                      />
                      <div className="overflow-hidden min-w-0 flex-1">
                        <span className="text-[9px] sm:text-[10px] font-bold text-brand-coral uppercase tracking-wider block truncate">
                          {slot.patientName}
                        </span>
                        <h4 className={`text-xs sm:text-sm font-semibold text-brand-teal leading-tight truncate ${isTaken ? "line-through text-gray-400" : ""}`}>
                          {med.name}
                        </h4>
                        <p className="text-[10px] sm:text-[11px] text-gray-500 font-sans mt-0.5 truncate">
                          {med.dosage} • {med.instructions || `${med.intervalHours}h em ${med.intervalHours}h`}
                        </p>
                      </div>
                    </div>

                    {/* Checkbox / Action button */}
                    <div className="flex items-center space-x-1 sm:space-x-1.5 shrink-0">
                      <button
                        onClick={() => !isTaken && toggleDoseTaken(med.medicamentoId, slot.time)}
                        disabled={isTaken}
                        className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center transition-all ${
                          isTaken
                            ? "bg-emerald-500 text-white shadow-xs cursor-not-allowed"
                            : "border border-brand-cream-darker text-gray-300 hover:text-brand-coral hover:border-brand-coral"
                        }`}
                        title={isTaken ? "Dose já confirmada" : "Marcar como tomado"}
                      >
                        <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[3]" />
                      </button>

                      {/* CRUD Delete Button for Medicines */}
                      <button
                        onClick={() => {
                          if (!isTaken) setConfirmDeleteMed({ medId: med.medicamentoId, medName: med.name, slotTime: slot.time });
                        }}
                        disabled={isTaken}
                        className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center transition-colors ${
                          isTaken ? "text-gray-200 cursor-not-allowed" : "text-gray-300 hover:text-red-500"
                        }`}
                        title={isTaken ? "Não é possível remover uma dose já confirmada" : "Remover medicamento"}
                      >
                        <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Reminder Config Service Worker Push Simulation Modal */}
      {showReminderModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <div className="w-12 h-12 rounded-full bg-brand-peach flex items-center justify-center mx-auto mb-4 text-brand-coral">
              <Bell className="w-6 h-6 fill-brand-coral/10" />
            </div>
            <h3 className="text-lg font-display font-bold text-brand-teal text-center mb-1">
              Alertas & Notificações Push
            </h3>
            <p className="text-xs text-gray-500 text-center mb-6">
              Configure as notificações do Service Worker para ser lembrado pontualmente sobre seus medicamentos.
            </p>

            <div className="space-y-2 mb-6">
              {[
                { offset: 0, label: "No horário exato da dose" },
                { offset: 5, label: "5 minutos antes" },
                { offset: 10, label: "10 minutos antes" },
                { offset: 15, label: "15 minutos antes" },
              ].map((opt) => (
                <button
                  key={opt.offset}
                  onClick={() => setReminderConfigured(opt.offset)}
                  className={`w-full text-left px-4 py-3 rounded-xl border text-xs font-semibold flex items-center justify-between transition-all ${
                    reminderConfigured === opt.offset
                      ? "bg-brand-teal text-brand-cream border-brand-teal shadow-xs"
                      : "bg-white border-brand-cream-darker text-brand-teal hover:bg-brand-peach"
                  }`}
                >
                  <span>{opt.label}</span>
                  {reminderConfigured === opt.offset && <Check className="w-4 h-4 stroke-[3]" />}
                </button>
              ))}
            </div>

            <button
              onClick={() => {
                onNotify(`Configurações de notificações atualizadas para lembrete ${reminderConfigured === 0 ? "no horário exato" : `${reminderConfigured} minutos antes`}!`);
                setShowReminderModal(false);
              }}
              className="w-full bg-brand-coral hover:bg-brand-coral-light text-brand-cream font-bold py-3.5 rounded-2xl transition-all shadow-md text-xs"
            >
              Salvar Lembretes Ativos
            </button>
          </div>
        </div>
      )}

      {/* Manual Add Medicine Modal */}
      {showAddMedModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm lg:max-w-md w-full p-6 shadow-xl border border-brand-cream-darker max-h-[85vh] overflow-y-auto animate-scale-up">
            <h3 className="text-lg font-display font-bold text-brand-teal mb-4">
              Adicionar Medicamento Manualmente
            </h3>
            <form onSubmit={handleCreateMedicine} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Paciente
                </label>
                <select
                  required
                  value={selectedPatientId}
                  onChange={(e) => setSelectedPatientId(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                >
                  <option value="">Selecione...</option>
                  {medicados.map(p => (
                    <option key={p.medicadoId} value={p.medicadoId}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Nome do Medicamento
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Paracetamol 500mg"
                  value={medName}
                  onChange={(e) => setMedName(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Dosagem
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: 1 comprimido, 5ml"
                    value={dosage}
                    onChange={(e) => setDosage(e.target.value)}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Categoria
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as MedicineCategory)}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
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

              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Data de Início / A partir de
                </label>
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Intervalo (Horas)
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    max="168"
                    value={intervalHours}
                    onChange={(e) => setIntervalHours(Number(e.target.value))}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Duração (Dias)
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    max="365"
                    value={durationDays}
                    onChange={(e) => setDurationDays(Number(e.target.value))}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Instruções Adicionais
                </label>
                <textarea
                  placeholder="Ex: Tomar após as refeições."
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral h-16 resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider flex items-center gap-1">
                  <Bell className="w-3.5 h-3.5" /> Lembrar antes da dose
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[5, 10].map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => setReminderConfigured(minutes)}
                      className={`px-3 py-2 rounded-xl border text-sm font-semibold flex items-center justify-center gap-1 transition-all ${
                        reminderConfigured === minutes
                          ? "bg-brand-teal text-brand-cream border-brand-teal shadow-xs"
                          : "bg-white border-brand-cream-darker text-brand-teal hover:bg-brand-peach"
                      }`}
                    >
                      {reminderConfigured === minutes && <Check className="w-4 h-4 stroke-[3]" />}
                      {minutes} minutos antes
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddMedModal(false)}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2 text-sm font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-brand-teal text-brand-cream rounded-xl py-2 text-sm font-semibold hover:bg-brand-teal-light transition-all shadow-sm"
                >
                  Adicionar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Dose Administration Modal */}
      {doseToConfirm && (
        <div className="fixed inset-0 bg-black/50 z-55 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <div className="w-12 h-12 rounded-full bg-brand-peach flex items-center justify-center mx-auto mb-4 text-brand-coral">
              <ShieldAlert className="w-6 h-6" />
            </div>
            
            <h3 className="text-lg font-display font-bold text-brand-teal text-center mb-1">
              Confirmar Ministração
            </h3>
            <p className="text-xs text-gray-500 text-center mb-5">
              Por favor, confirme se você ministrou o seguinte medicamento.
            </p>

            <div className="bg-white border border-brand-cream-darker rounded-2xl p-4 mb-5 flex items-start gap-3">
              <img
                src={doseToConfirm.avatar}
                alt={doseToConfirm.patientName}
                referrerPolicy="no-referrer"
                className="w-10 h-10 rounded-full object-cover border border-brand-teal/10 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <span className="text-[9px] font-bold text-brand-coral uppercase tracking-wider block">
                  {doseToConfirm.patientName}
                </span>
                <h4 className="text-sm font-semibold text-brand-teal leading-tight truncate">
                  {doseToConfirm.medName}
                </h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  Dosagem: <span className="font-semibold text-brand-teal">{doseToConfirm.dosage}</span>
                </p>
                <div className="flex items-center gap-1.5 mt-2 text-[10px] text-gray-500 font-mono">
                  <Clock className="w-3.5 h-3.5 text-brand-coral" />
                  <span>Horário Programado: <strong className="text-brand-teal">{doseToConfirm.slotTime}</strong></span>
                </div>
              </div>
            </div>

            <form onSubmit={handleConfirmDose} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Horário Real da Ministração
                </label>
                <div className="flex gap-2">
                  <input
                    type="time"
                    required
                    value={confirmTime}
                    onChange={(e) => setConfirmTime(e.target.value)}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral font-mono text-center"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const now = new Date();
                      const hr = String(now.getHours()).padStart(2, "0");
                      const min = String(now.getMinutes()).padStart(2, "0");
                      setConfirmTime(`${hr}:${min}`);
                    }}
                    className="px-3 bg-brand-teal-pale border border-brand-teal/10 text-brand-teal text-xs font-bold rounded-xl hover:bg-brand-peach transition-colors shrink-0"
                  >
                    Agora
                  </button>
                </div>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDoseToConfirm(null)}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-brand-coral hover:bg-brand-coral-light text-brand-cream rounded-xl py-2.5 text-xs font-semibold transition-all shadow-md"
                >
                  Confirmar Dose
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteMed}
        title="Excluir medicamento"
        message={`Excluir permanentemente ${confirmDeleteMed?.medName}? Isso vai remover TODOS os horários deste medicamento — hoje e nos próximos dias — não apenas a dose das ${confirmDeleteMed?.slotTime}. Essa ação não pode ser desfeita.`}
        danger
        confirmLabel="Excluir"
        onConfirm={() => {
          if (confirmDeleteMed) onDeleteMedicine(confirmDeleteMed.medId);
          setConfirmDeleteMed(null);
        }}
        onCancel={() => setConfirmDeleteMed(null)}
      />
    </div>
  );
}
