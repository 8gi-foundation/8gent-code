/**
 * React hook for boolean toggle state.
 * @param initial Initial value (default false)
 * @returns [value, toggle, setTrue, setFalse]
 */
function useToggle(initial?: boolean): [boolean, () => void, () => void, () => void] {
  const [value, setValue] = useState(initial || false)
  const toggle = () => setValue(prev => !prev)
  const setTrue = () => setValue(true)
  const setFalse = () => setValue(false)
  return [value, toggle, setTrue, setFalse]
}

export { useToggle }