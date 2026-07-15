import React from "react";
import { LayoutGrid, Calendar, ShoppingBag, User, FileText } from "lucide-react";

interface BottomNavBarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export default function BottomNavBar({
  activeTab,
  setActiveTab,
}: BottomNavBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-brand-cream border-t border-brand-cream-darker px-4 pb-safe shadow-lg lg:top-0 lg:bottom-0 lg:right-auto lg:w-24 lg:h-screen lg:px-0 lg:py-8 lg:border-t-0 lg:border-r lg:pb-0 lg:shadow-none">
      <div className="max-w-md mx-auto flex items-center justify-between h-20 relative lg:max-w-none lg:mx-0 lg:h-full lg:flex-col lg:justify-center lg:items-center lg:gap-10">
        {/* Left Side Buttons */}
        <div className="flex space-x-6 lg:flex-col lg:space-x-0 lg:space-y-8">
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

        {/* Right Side Buttons */}
        <div className="flex space-x-6 lg:flex-col lg:space-x-0 lg:space-y-8">
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
            id="nav-receitas"
            onClick={() => setActiveTab("receitas")}
            className={`flex flex-col items-center justify-center p-2 transition-all relative ${
              activeTab === "receitas" ? "text-brand-teal scale-110" : "text-gray-400 hover:text-brand-teal-light"
            }`}
          >
            <FileText className="w-6 h-6 stroke-[2]" />
            <span className="text-[10px] font-medium mt-1 font-sans">Receitas</span>
            {activeTab === "receitas" && (
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
