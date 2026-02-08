import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io("http://localhost:5000"); // backend url

function App() {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    socket.on("facebookMessage", (data) => {
      setMessages((prev) => [...prev, data]);
    });

    return () => socket.off("facebookMessage");
  }, []);

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>📡 Facebook Bot Live Monitor</h2>

      <div style={styles.chatBox}>
        {messages.length === 0 && (
          <p style={{ textAlign: "center" }}>Waiting for messages...</p>
        )}

        {messages.map((msg, index) => (
          <div key={index} style={styles.card}>
            <p><b>Page ID:</b> {msg.pageId}</p>
            <p><b>User:</b> {msg.userMessage}</p>
            <p><b>Bot:</b> {msg.botReply}</p>
            <p style={styles.time}>{msg.time}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  container: {
    padding: "20px",
    fontFamily: "Arial",
    background: "#f4f6f8",
    minHeight: "100vh",
  },
  title: {
    textAlign: "center",
  },
  chatBox: {
    maxWidth: "800px",
    margin: "20px auto",
    background: "#fff",
    padding: "15px",
    borderRadius: "8px",
    height: "80vh",
    overflowY: "auto",
  },
  card: {
    borderBottom: "1px solid #ddd",
    padding: "10px 0",
  },
  time: {
    fontSize: "12px",
    color: "#888",
  },
};

export default App;
