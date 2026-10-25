import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {Onboarding} from './components/Welcome';
import './ui/tokens.css';
import './ui/ui.css';
import './styles.css';
import './styles/ask.css';
import './styles/settings-ai.css';
import './styles/focus.css';
import './styles/reader.css';
import './styles/calendar.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string}>{state={error:''};static getDerivedStateFromError(e:Error){return {error:e.message};}render(){return this.state.error?<div className="fatal"><h1>Let’s get you back to your mail.</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>Reload Aplos Mail</button></div>:this.props.children;}}
// The onboarding window (and the preview's first run) load the same bundle with `?onboarding`.
const onboarding=new URLSearchParams(location.search).has('onboarding');
createRoot(document.getElementById('root')!).render(<ErrorBoundary>{onboarding?<Onboarding/>:<App/>}</ErrorBoundary>);
