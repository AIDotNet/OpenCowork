import React, { useState, useRef, useEffect } from 'react';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { RegisterModal } from './register-modal';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface LoginModalProps {
  onClose?: () => void;
  onSwitchToRegister?: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onClose, onSwitchToRegister }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { login, isLoading } = useAuthStore();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Handle browser autofill - check periodically
  useEffect(() => {
    const checkAutofill = () => {
      if (usernameRef.current?.value && !username) {
        setUsername(usernameRef.current.value);
      }
      if (passwordRef.current?.value && !password) {
        setPassword(passwordRef.current.value);
      }
    };

    // Check multiple times to catch autofill
    const timer1 = setTimeout(checkAutofill, 100);
    const timer2 = setTimeout(checkAutofill, 500);
    const timer3 = setTimeout(checkAutofill, 1000);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [username, password]);

  const handleSwitchToRegister = () => {
    if (onSwitchToRegister) {
      onSwitchToRegister();
    } else {
      setShowRegister(true);
    }
  };

  if (showRegister) {
    return <RegisterModal onClose={onClose} onSwitchToLogin={() => setShowRegister(false)} />;
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Clear previous error
    setError('');

    // Method 1: Try FormData first (most reliable for autofill)
    const formData = new FormData(e.currentTarget);
    const formUsername = formData.get('username') as string;
    const formPassword = formData.get('password') as string;

    // Method 2: Fallback to refs
    const refUsername = usernameRef.current?.value || '';
    const refPassword = passwordRef.current?.value || '';

    // Use whichever has values
    const currentUsername = formUsername || refUsername || username;
    const currentPassword = formPassword || refPassword || password;

    // Update state for UI consistency
    if (currentUsername && currentUsername !== username) setUsername(currentUsername);
    if (currentPassword && currentPassword !== password) setPassword(currentPassword);

    // Validate inputs
    if (!currentUsername.trim() || !currentPassword.trim()) {
      setError('用户名和密码为必填项');
      return;
    }

    try {
      await login(currentUsername, currentPassword);
      if (onClose) onClose();
    } catch (err: any) {
      setError(err.message || '登录失败');
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border bg-card p-8 shadow-lg">
        {/* Header */}
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">欢迎登录</h1>
          <p className="text-sm text-muted-foreground">企业多智能体协作平台</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Error Message */}
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Username Field */}
          <div className="space-y-2">
            <label htmlFor="username" className="text-sm font-medium text-foreground">
              用户名
            </label>
            <Input
              ref={usernameRef}
              id="username"
              name="username"
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError('');
              }}
              placeholder="请输入用户名"
              disabled={isLoading}
              autoFocus
              autoComplete="username"
            />
          </div>

          {/* Password Field */}
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              密码
            </label>
            <div className="relative">
              <Input
                ref={passwordRef}
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                placeholder="请输入密码"
                disabled={isLoading}
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={isLoading}
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
          </div>

          {/* Hidden submit button for Enter key */}
          <input type="submit" style={{ display: 'none' }} />

          {/* Submit Button */}
          <Button
            type="submit"
            disabled={isLoading}
            className="w-full"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                登录中...
              </>
            ) : (
              '登录'
            )}
          </Button>

          {/* Register Link */}
          <div className="text-center text-sm">
            <span className="text-muted-foreground">还没有账号？ </span>
            <button
              type="button"
              onClick={handleSwitchToRegister}
              disabled={isLoading}
              className="font-medium text-primary hover:text-primary/80 disabled:pointer-events-none disabled:opacity-50"
            >
              立即注册
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
