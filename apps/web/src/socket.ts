
import { io } from "socket.io-client";

export const socket = io("https://collab-code-editor-br7u.onrender.com", {
  autoConnect: true,
  transports: ["websocket", "polling"],
});
