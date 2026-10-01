import { createClient } from './client';

/**
 * Teacher e-mail / password authentication helpers.
 *
 * v2 keeps Supabase Auth as the identity provider: `auth.uid()` is what every
 * RLS policy on `exams` / `question_bank` / `students` keys off.
 */

export async function signInWithPassword(email: string, password: string) {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function signOut() {
  const supabase = createClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function getCurrentUser() {
  const supabase = createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) return null;
  return user;
}
