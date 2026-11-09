export function Soon({ title, text }: { title: string; text: string }) {
  return (
    <>
      <div className="head"><div><h1>{title}</h1></div></div>
      <div className="card placeholder">
        <div className="big">В работе</div>
        <p className="muted">{text}</p>
      </div>
    </>
  )
}
