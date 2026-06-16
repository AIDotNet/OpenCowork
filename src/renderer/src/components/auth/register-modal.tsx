import React, { useState } from 'react';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface RegisterModalProps {
  onClose?: () => void;
  onSwitchToLogin?: () => void;
}

export const RegisterModal: React.FC<RegisterModalProps> = ({ onClose, onSwitchToLogin }) => {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
    phone: ''
  });
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { register, isLoading } = useAuthStore();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    if (error) setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!formData.username.trim() || !formData.email.trim() || !formData.password) {
      setError('请填写所有必填项');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('两次密码输入不一致');
      return;
    }

    if (formData.password.length < 6) {
      setError('密码长度至少6位');
      return;
    }

    try {
      await register({
        username: formData.username,
        email: formData.email,
        password: formData.password,
        displayName: formData.displayName,
        phone: formData.phone
      });
      if (onClose) onClose();
    } catch (err: any) {
      setError(err.message || '注册失败');
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border bg-card p-8 shadow-lg">
        {/* Header */}
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">创建账号</h1>
          <p className="text-sm text-muted-foreground">加入 OpenCowork 多智能体协作平台</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Error Message */}
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Username */}
          <div className="space-y-2">
            <label htmlFor="reg-username" className="text-sm font-medium text-foreground">
              用户名 <span className="text-destructive">*</span>
            </label>
            <Input
              id="reg-username"
              name="username"
              type="text"
              value={formData.username}
              onChange={handleChange}
              placeholder="请输入用户名"
              disabled={isLoading}
              required
            />
          </div>

          {/* Email */}
          <div className="space-y-2">
            <label htmlFor="reg-email" className="text-sm font-medium text-foreground">
              邮箱 <span className="text-destructive">*</span>
            </label>
            <Input
              id="reg-email"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="your@email.com"
              disabled={isLoading}
              required
            />
          </div>

          {/* Password */}
          <div className="space-y-2">
            <label htmlFor="reg-password" className="text-sm font-medium text-foreground">
              密码 <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Input
                id="reg-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={formData.password}
                onChange={handleChange}
                placeholder="至少6位密码"
                disabled={isLoading}
                required
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

          {/* Confirm Password */}
          <div className="space-y-2">
            <label htmlFor="reg-confirm-password" className="text-sm font-medium text-foreground">
              确认密码 <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Input
                id="reg-confirm-password"
                name="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                value={formData.confirmPassword}
                onChange={handleChange}
                placeholder="再次输入密码"
                disabled={isLoading}
                required
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={isLoading}
                tabIndex={-1}
              >
                {showConfirmPassword ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
          </div>

          {/* Display Name */}
          <div className="space-y-2">
            <label htmlFor="reg-display-name" className="text-sm font-medium text-foreground">
              姓名
            </label>
            <Input
              id="reg-display-name"
              name="displayName"
              type="text"
              value={formData.displayName}
              onChange={handleChange}
              placeholder="请输入姓名（可选）"
              disabled={isLoading}
            />
          </div>

          {/* Phone */}
          <div className="space-y-2">
            <label htmlFor="reg-phone" className="text-sm font-medium text-foreground">
              手机号
            </label>
            <Input
              id="reg-phone"
              name="phone"
              type="tel"
              value={formData.phone}
              onChange={handleChange}
              placeholder="请输入手机号（可选）"
              disabled={isLoading}
            />
          </div>

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
                注册中...
              </>
            ) : (
              '注册'
            )}
          </Button>

          {/* Login Link */}
          <div className="text-center text-sm">
            <span className="text-muted-foreground">已有账号？ </span>
            <button
              type="button"
              onClick={onSwitchToLogin}
              disabled={isLoading}
              className="font-medium text-primary hover:text-primary/80 disabled:pointer-events-none disabled:opacity-50"
            >
              立即登录
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
