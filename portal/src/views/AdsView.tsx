import { useState } from 'react'

const ADS_URL = 'https://pghubads.web.app'

export default function AdsView() {
  const [loading, setLoading] = useState(true)

  return (
    <div className="ads-frame-wrap">
      {loading && (
        <div className="ads-frame-loading">
          <div className="spinner" />
          <span>Loading PG Hub Ads…</span>
        </div>
      )}
      <iframe
        src={ADS_URL}
        title="PG Hub Ads"
        className="ads-frame"
        style={{ opacity: loading ? 0 : 1 }}
        onLoad={() => setLoading(false)}
        allow="popups"
      />
    </div>
  )
}
