import Editor from "@monaco-editor/react";

function App() {
  return (
    <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column", backgroundColor: "#020617", color: "white" }}>
      <header
        style={{
          height: "56px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          backgroundColor: "#0f172a",
        }}
      >
        <h1 style={{ fontSize: "18px", fontWeight: 600 }}>Collab Code Editor</h1>
        <button
          style={{
            backgroundColor: "#2563eb",
            color: "white",
            border: "none",
            padding: "10px 16px",
            borderRadius: "8px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: 500,
          }}
        >
          Share
        </button>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <aside
          style={{
            width: "260px",
            borderRight: "1px solid #1e293b",
            backgroundColor: "#0f172a",
            padding: "16px",
          }}
        >
          <h2 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px" }}>Explorer</h2>
          <div style={{ fontSize: "14px", color: "#94a3b8" }}>main.ts</div>
        </aside>

        <main style={{ flex: 1 }}>
          <Editor
            height="100%"
            defaultLanguage="typescript"
            defaultValue={`function greet(name: string) {
  return \`Hello, \${name}\`;
}

console.log(greet("World"));
`}
            theme="vs-dark"
          />
        </main>
      </div>
    </div>
  );
}

export default App;