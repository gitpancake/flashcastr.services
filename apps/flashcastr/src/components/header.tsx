import Image from "next/image";

export function Header() {
  return (
    <div className="flex items-center gap-3 bg-black px-4 py-2">
      <Image
        src="/splash.png"
        width={1920}
        height={1080}
        alt="Flashcastr"
        className="h-[40px] w-[40px]"
      />
      <h1
        className="text-white text-2xl"
        style={{ fontFamily: "'Space Invaders', monospace" }}
      >
        Flashcastr
      </h1>
    </div>
  );
}
