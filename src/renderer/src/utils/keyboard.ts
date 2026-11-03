/** Some IMEs report keyCode 229 on their final key without isComposing. */
export const isComposingKey = (event: { isComposing?: boolean; keyCode?: number }) => event.isComposing === true || event.keyCode === 229
