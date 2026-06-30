export async function fetchUserName(userId: string) {
  const response = await fetch(`https://api.example.com/users/${userId}`);
  const payload = await response.json();

  return payload.name;
}
