import React from "react";
import { LayoutGrid, Calendar, ShoppingBag, User, Plus } from "lucide-react";

interface BottomNavBarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onAddClick: () => void;
}

export default function BottomNavBar({
  activeTab,
  setActiveTab,
  onAddClick,
}: BottomNavBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-brand-cream border-t border-brand-cream-darker px-4 pb-safe shadow-lg">
      <div className="max-w-md mx-auto flex items-center justify-between h-20 relative">
        {/* Left Side Buttons */}
        <div className="flex space-x-8">
          <button
            id="nav-home"
            onClick={() => setActiveTab("home")}
            className={`flex flex-col items-center justify-center p-2 transition-all relative ${
              activeTab === "home" ? "text-brand-teal scale-110" : "text-gray-400 hover:text-brand-teal-light"
            }`}
          >
            <LayoutGrid className="w-6 h-6 stroke-[2]" />
            <span className="text-[10px] font-medium mt-1 font-sans">Início</span>
            {activeTab === "home" && (
              <span className="absolute bottom-1 w-1 h-1 rounded-full bg-brand-coral" />
            )}
          </button>

          <button
            id="nav-schedule"
            onClick={() => setActiveTab("schedule")}
            className={`flex flex-col items-center justify-center p-2 transition-all relative ${
              activeTab === "schedule" ? "text-brand-teal scale-110" : "text-gray-400 hover:text-brand-teal-light"
            }`}
          >
            <Calendar className="w-6 h-6 stroke-[2]" />
            <span className="text-[10px] font-medium mt-1 font-sans">Agenda</span>
            {activeTab === "schedule" && (
              <span className="absolute bottom-1 w-1 h-1 rounded-full bg-brand-coral" />
            )}
          </button>
        </div>

        {/* Central Floating Action Button */}
        <div className="absolute left-1/2 -translate-x-1/2 -top-6">
          <button
            id="fab-scan"
            onClick={onAddClick}
            className="w-14 h-14 rounded-full bg-brand-coral hover:bg-brand-coral-light text-brand-cream flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95 border-4 border-brand-cream"
            aria-label="Escanear Receita"
          >
            <Plus className="w-8 h-8 stroke-[3]" />
          </button>
          <span className="block text-center text-[10px] font-semibold text-brand-teal mt-1 font-sans">
            Escanear
          </span>
        </div>

        {/* Right Side Buttons */}
        <div className="flex space-x-8">
          <button
            id="nav-pharmacies"
            onClick={() => setActiveTab("pharmacies")}
            className={`flex flex-col items-center justify-center p-2 transition-all relative ${
              activeTab === "pharmacies" ? "text-brand-teal scale-110" : "text-gray-400 hover:text-brand-teal-light"
            }`}
          >
            <ShoppingBag className="w-6 h-6 stroke-[2]" />
            <span className="text-[10px] font-medium mt-1 font-sans">Farmácias</span>
            {activeTab === "pharmacies" && (
              <span className="absolute bottom-1 w-1 h-1 rounded-full bg-brand-coral" />
            )}
          </button>

          <button
            id="nav-profile"
            onClick={() => setActiveTab("profile")}
            className={`flex flex-col items-center justify-center p-2 transition-all relative ${
              activeTab === "profile"
                ? "text-brand-teal scale-110"
                : "text-gray-400 hover:text-brand-teal-light"
            }`}
          >
            <User className="w-6 h-6 stroke-[2]" />
            <span className="text-[10px] font-medium mt-1 font-sans">
              Perfil
            </span>
            {activeTab === "profile" && (
              <span className="absolute bottom-1 w-1 h-1 rounded-full bg-brand-coral" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
